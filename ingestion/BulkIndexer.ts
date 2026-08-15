import type { Client } from '@elastic/elasticsearch';
import type { WikipediaIndex } from '../es/WikipediaIndex.js';
import type { WikiDocument } from '../types.js';

export interface DroppedDocument {
  wikiId: number | null;
  title: string | null;
  status: number;
  reason: string;
}

export interface BulkIndexStats {
  total: number;
  failed: number;
  retried: number;
  seconds: number;
  docsPerSecond: number;
  countInEs: number;
  sizeBytes: number;
  segments: number;
  dropped: DroppedDocument[];
}

export interface BulkIndexerOptions {
  /** Bytes accumulated before a bulk request is sent. */
  flushBytes?: number;
  /** Bulk requests in flight at once. */
  concurrency?: number;
  /** Retries for documents rejected with a retryable status (429). */
  retries?: number;
}

/**
 * Cleaned documents -> Elasticsearch, via the bulk API.
 *
 * Two decisions here are worth understanding rather than copying:
 *
 * 1. `_id` is the MediaWiki page id. Those ids are stable, so re-running a load
 *    updates documents in place instead of appending duplicates. The whole
 *    ingest becomes idempotent and safely resumable.
 *
 * 2. `refresh_interval` is disabled for the duration. Elasticsearch normally
 *    opens a fresh Lucene segment once a second so that recent writes become
 *    searchable; during a bulk load that produces thousands of tiny segments
 *    which then have to be merged away, competing with the load for IO. Turning
 *    it off trades searchability for throughput, and one explicit refresh at the
 *    end makes everything visible. This is roadmap item 29 seen from the write
 *    side, and the segment count in the returned stats is item 27.
 */
export class BulkIndexer<T extends WikiDocument = WikiDocument> {
  private readonly flushBytes: number;
  private readonly concurrency: number;
  private readonly retries: number;

  constructor(
    private readonly client: Client,
    private readonly index: WikipediaIndex,
    options: BulkIndexerOptions = {},
  ) {
    this.flushBytes = options.flushBytes ?? 5_000_000;
    // Two in flight is plenty against a single node; more just queues on the
    // write threadpool and inflates the chance of 429s.
    this.concurrency = options.concurrency ?? 2;
    this.retries = options.retries ?? 3;
  }

  async run(source: AsyncIterable<T>): Promise<BulkIndexStats> {
    const dropped: DroppedDocument[] = [];
    const started = Date.now();

    await this.index.setRefreshInterval('-1');

    let total = 0;
    let failed = 0;
    let retried = 0;

    try {
      const result = await this.client.helpers.bulk<T>({
        // The helper's type asks for an AsyncIterator (something with next()),
        // while this method accepts the friendlier AsyncIterable (something
        // usable in for-await). An async generator satisfies both; take the
        // iterator off the iterable to line up with the declared type.
        datasource: source[Symbol.asyncIterator](),
        // `index` rather than `create` so a re-run overwrites instead of
        // erroring on documents that already exist.
        onDocument: (document) => ({
          index: { _index: this.index.name, _id: String(document.wiki_id) },
        }),
        onDrop: (doc) => {
          dropped.push({
            wikiId: doc.document?.wiki_id ?? null,
            title: doc.document?.title ?? null,
            status: doc.status,
            reason: doc.error?.reason ?? 'unknown',
          });
        },
        flushBytes: this.flushBytes,
        concurrency: this.concurrency,
        retries: this.retries,
      });

      total = result.total;
      failed = result.failed;
      retried = result.retry;
    } finally {
      // Restore near-real-time behaviour even if the load threw, so the index
      // is never left silently frozen.
      await this.index.setRefreshInterval('1s');
    }

    await this.index.refresh();

    const seconds = (Date.now() - started) / 1000;
    const { sizeBytes, segments } = await this.index.primaryStats();

    return {
      total,
      failed,
      retried,
      seconds,
      docsPerSecond: seconds > 0 ? total / seconds : 0,
      countInEs: await this.index.count(),
      sizeBytes,
      segments,
      dropped,
    };
  }
}
