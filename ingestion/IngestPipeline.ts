import fs from 'node:fs';
import { CorpusBuilder } from './CorpusBuilder.js';
import { JsonlCorpus } from './JsonlCorpus.js';
import { BulkIndexer } from './BulkIndexer.js';
import { DocumentTransform } from './DocumentTransform.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import type { SearchCluster } from '../es/SearchCluster.js';
import type { CorpusBuildStats } from './CorpusBuilder.js';
import type { BulkIndexStats } from './BulkIndexer.js';
import type { IndexedDocument } from '../types.js';

export interface IngestPipelineOptions {
  dumpPath: string;
  corpusPath?: string;
  indexName?: string;
  /** Stop after this many documents. Useful for a fast end-to-end smoke test. */
  limit?: number;
  /** Rebuild the JSONL even if it already exists. */
  rebuildCorpus?: boolean;
  onLog?: (message: string) => void;
}

export interface IngestReport {
  corpusPath: string;
  indexName: string;
  /** null when an existing JSONL was reused. */
  corpus: CorpusBuildStats | null;
  corpusReused: boolean;
  bulk: BulkIndexStats;
  seconds: number;
}

/**
 * The whole ingest, end to end: XML dump -> cleaned JSONL -> index -> documents.
 *
 * Four stages, run in order:
 *
 *   1. collect redirects   (pass 1 over the XML)
 *   2. clean to JSONL      (pass 2 over the XML)
 *   3. create the index    (settings + mapping + alias)
 *   4. bulk load           (JSONL -> Elasticsearch)
 *
 * Stages 1 and 2 are skipped when the JSONL already exists, because that file is
 * the expensive artifact and it does not change when a mapping does. Reindexing
 * with a different analyzer means rerunning stages 3 and 4 only — a minute
 * rather than several.
 */
export class IngestPipeline {
  private readonly corpusPath: string;
  private readonly indexName: string;
  private readonly limit: number;
  private readonly rebuildCorpus: boolean;
  private readonly log: (message: string) => void;

  constructor(
    private readonly cluster: SearchCluster,
    private readonly options: IngestPipelineOptions,
  ) {
    this.corpusPath = options.corpusPath ?? 'data/wikipedia.jsonl';
    this.indexName = options.indexName ?? WikipediaIndex.DEFAULT_NAME;
    this.limit = options.limit ?? Number.POSITIVE_INFINITY;
    this.rebuildCorpus = options.rebuildCorpus ?? false;
    this.log = options.onLog ?? ((): void => {});
  }

  async run(): Promise<IngestReport> {
    const started = Date.now();

    const { stats: corpus, reused } = await this.buildCorpus();
    const bulk = await this.loadIntoElasticsearch();

    return {
      corpusPath: this.corpusPath,
      indexName: this.indexName,
      corpus,
      corpusReused: reused,
      bulk,
      seconds: (Date.now() - started) / 1000,
    };
  }

  /** Stages 1 and 2. */
  private async buildCorpus(): Promise<{ stats: CorpusBuildStats | null; reused: boolean }> {
    const alreadyBuilt = fs.existsSync(this.corpusPath);

    if (alreadyBuilt && !this.rebuildCorpus) {
      const megabytes = (fs.statSync(this.corpusPath).size / 1e6).toFixed(0);
      this.log(`[1-2/4] reusing ${this.corpusPath} (${megabytes} MB) — pass --rebuild to redo it`);
      return { stats: null, reused: true };
    }

    if (!fs.existsSync(this.options.dumpPath)) {
      throw new Error(`dump not found: ${this.options.dumpPath}`);
    }

    const builder = new CorpusBuilder(this.options.dumpPath, this.corpusPath, {
      limit: this.limit,
      onProgress: (written) => this.log(`          ${written} docs cleaned`),
    });

    this.log('[1/4] collecting redirects');
    const redirects = await builder.collectRedirects();
    this.log(`      ${redirects.total} stubs -> ${redirects.targetCount} target articles`);

    this.log(`[2/4] cleaning wikitext -> ${this.corpusPath}`);
    const stats = await builder.build(redirects);
    this.log(
      `      ${stats.written} written, ${stats.skipped} skipped, ${(stats.bytes / 1e6).toFixed(0)} MB`,
    );

    return { stats, reused: false };
  }

  /** Stages 3 and 4. */
  private async loadIntoElasticsearch(): Promise<BulkIndexStats> {
    const index = new WikipediaIndex(this.cluster.client, this.indexName);

    this.log(`[3/4] creating index ${index.name} (alias: ${index.alias})`);
    await index.recreate();

    this.log(`[4/4] bulk loading ${this.corpusPath}`);
    const corpus = new JsonlCorpus(this.corpusPath, this.limit);
    const indexer = new BulkIndexer<IndexedDocument>(this.cluster.client, index);
    // Derive autocomplete inputs on the way past — see DocumentTransform for
    // why this is not baked into the corpus file.
    return indexer.run(DocumentTransform.withSuggest(corpus.documents()));
  }
}
