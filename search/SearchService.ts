import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { BM25Explainer } from './BM25Explainer.js';
import { QueryBuilder } from './QueryBuilder.js';
import type { Client, estypes } from '@elastic/elasticsearch';
import type { WikiDocument } from '../types.js';
import type { ExplanationNode, ScoreBreakdown } from './BM25Explainer.js';
import type { BooleanQuerySpec } from './QueryBuilder.js';

/**
 * The values Elasticsearch sorts by, echoed back on each hit. Derived from
 * SearchHit rather than named directly, so it stays correct across client
 * versions.
 */
type SortCursor = NonNullable<estypes.SearchHit['sort']>;

export interface SearchParams {
  q: string;
  from?: number;
  size?: number;
  highlight?: boolean;
  /** Opaque cursor from a previous response. Overrides `from` when present. */
  after?: string;
}

export interface SearchHit {
  wiki_id: number;
  title: string;
  url: string;
  score: number;
  short_description: string | null;
  opening_text: string;
  categories: string[];
  /** Field name -> matched fragments wrapped in <mark>. */
  highlights?: Record<string, string[]>;
}

export interface SearchResponse {
  query: string;
  strategy: string;
  total: number;
  took: number;
  from: number;
  size: number;
  hits: SearchHit[];
  /** Pass back as `after` to fetch the next page without a deep `from`. */
  next_cursor: string | null;
}

export interface Suggestion {
  title: string;
  score: number;
}

export interface ExplainResponse {
  wiki_id: number;
  title: string | null;
  query: string;
  matched: boolean;
  breakdown: ScoreBreakdown;
  raw: unknown;
}

export interface IndexSummary {
  index: string;
  documents: number;
  sizeBytes: number;
  segments: number;
}

/**
 * Every query the application knows how to run.
 *
 * The separate entry points exist so the same words can be compared across
 * strategies — that comparison, scored by the relevance harness, is how field
 * weights stop being guesses.
 */
export class SearchService {
  /** Returned to clients; the full `text` field is far too large to ship. */
  static readonly SUMMARY_FIELDS = [
    'wiki_id',
    'title',
    'url',
    'short_description',
    'opening_text',
    'categories',
  ];

  /** Elasticsearch's default index.max_result_window. */
  static readonly MAX_RESULT_WINDOW = 10_000;

  constructor(
    private readonly client: Client,
    private readonly index: string = WikipediaIndex.ALIAS,
  ) {}

  /** Weighted multi_match across every searchable field. */
  async search(params: SearchParams): Promise<SearchResponse> {
    return this.run(QueryBuilder.multiMatch(params.q), params, 'multi_match/best_fields');
  }

  /** Single-field `match` — the baseline to compare weighted search against. */
  async simple(params: SearchParams, field = 'text'): Promise<SearchResponse> {
    return this.run(QueryBuilder.match(params.q, field), params, `match/${field}`);
  }

  /** `match_phrase` — terms must be adjacent and in order. */
  async phrase(params: SearchParams, field = 'text'): Promise<SearchResponse> {
    return this.run(QueryBuilder.phrase(params.q, field), params, `match_phrase/${field}`);
  }

  /** Edit-distance tolerant search: "elastisearch" finds "Elasticsearch". */
  async fuzzy(params: SearchParams): Promise<SearchResponse> {
    return this.run(QueryBuilder.fuzzy(params.q), params, 'multi_match/fuzzy:AUTO');
  }

  /** Prefix matching without any supporting index structure — the slow way. */
  async prefix(params: SearchParams, field = 'title'): Promise<SearchResponse> {
    return this.run(
      QueryBuilder.phrasePrefix(params.q, field),
      params,
      `match_phrase_prefix/${field}`,
    );
  }

  /** must / should / must_not / filter, combined. */
  async boolean(spec: BooleanQuerySpec, params: SearchParams): Promise<SearchResponse> {
    return this.run(QueryBuilder.boolean(spec), params, 'bool');
  }

  /**
   * Autocomplete via the completion suggester.
   *
   * This does not touch the inverted index at all. Elasticsearch walks an FST
   * held in memory, which is why it answers in about a millisecond and why it
   * needed its own field, populated at index time. Compare against `prefix()`,
   * which does the same job by expanding terms at query time.
   */
  async suggest(prefix: string, size = 10): Promise<Suggestion[]> {
    const response = await this.client.search<WikiDocument>({
      index: this.index,
      _source: false,
      suggest: {
        titles: {
          prefix,
          completion: {
            field: 'title_suggest',
            size,
            // One article can be reachable by many redirect inputs; without
            // this the same title comes back repeatedly.
            skip_duplicates: true,
          },
        },
      },
    });

    const entries = response.suggest?.['titles'];
    const first = Array.isArray(entries) ? entries[0] : undefined;
    const options = first && 'options' in first ? first.options : undefined;
    const list = Array.isArray(options) ? options : options ? [options] : [];

    return list.map((option) => ({
      title: String((option as { text?: unknown }).text ?? ''),
      score: Number((option as { _score?: unknown })._score ?? 0),
    }));
  }

  async byId(wikiId: number): Promise<WikiDocument | null> {
    const response = await this.client.search<WikiDocument>({
      index: this.index,
      size: 1,
      query: { term: { wiki_id: wikiId } },
    });
    return response.hits.hits[0]?._source ?? null;
  }

  /**
   * Why did this document score what it scored?
   *
   * Runs the same weighted query `search` runs, against one document, and
   * flattens Lucene's explanation into per-term idf/tf/boost contributions.
   */
  async explain(wikiId: number, q: string): Promise<ExplainResponse> {
    const document = await this.byId(wikiId);

    const response = await this.client.explain({
      index: this.index,
      id: String(wikiId),
      query: QueryBuilder.multiMatch(q),
    });

    return {
      wiki_id: wikiId,
      title: document?.title ?? null,
      query: q,
      matched: response.matched,
      breakdown: BM25Explainer.summarize(response.explanation as ExplanationNode | undefined),
      raw: response.explanation,
    };
  }

  async summary(): Promise<IndexSummary> {
    const stats = await this.client.indices.stats({ index: this.index });
    const primaries = stats._all?.primaries;
    return {
      index: this.index,
      documents: primaries?.docs?.count ?? 0,
      sizeBytes: primaries?.store?.size_in_bytes ?? 0,
      segments: primaries?.segments?.count ?? 0,
    };
  }

  private async run(
    query: estypes.QueryDslQueryContainer,
    params: SearchParams,
    strategy: string,
  ): Promise<SearchResponse> {
    const from = Math.max(0, params.from ?? 0);
    const size = Math.min(Math.max(1, params.size ?? 10), 100);
    const after = SearchService.decodeCursor(params.after);

    if (after === null && from + size > SearchService.MAX_RESULT_WINDOW) {
      throw new Error(
        `from + size exceeds ${SearchService.MAX_RESULT_WINDOW}. Every shard must sort ` +
          `from+size hits to answer a deep page; use the next_cursor value as ?after= instead.`,
      );
    }

    const response = await this.client.search<WikiDocument>({
      index: this.index,
      // search_after replaces `from` entirely — the cursor IS the offset.
      ...(after === null ? { from } : { search_after: after }),
      size,
      _source: SearchService.SUMMARY_FIELDS,
      query,
      // A total ordering is required for search_after to be stable, so score
      // alone is not enough — wiki_id breaks ties deterministically.
      sort: [{ _score: { order: 'desc' } }, { wiki_id: { order: 'asc' } }],
      ...(params.highlight === true ? { highlight: QueryBuilder.highlight() } : {}),
      // Exact counts past 10k cost real work; ask for the true number anyway,
      // since 21k documents makes it cheap and the number is more useful.
      track_total_hits: true,
    });

    const total = response.hits.total;
    const lastHit = response.hits.hits[response.hits.hits.length - 1];

    return {
      query: params.q,
      strategy,
      total: typeof total === 'number' ? total : (total?.value ?? 0),
      took: response.took,
      from: after === null ? from : 0,
      size,
      hits: response.hits.hits.map((hit) => ({
        wiki_id: hit._source?.wiki_id ?? 0,
        title: hit._source?.title ?? '',
        url: hit._source?.url ?? '',
        score: hit._score ?? 0,
        short_description: hit._source?.short_description ?? null,
        opening_text: hit._source?.opening_text ?? '',
        categories: hit._source?.categories ?? [],
        ...(hit.highlight ? { highlights: hit.highlight } : {}),
      })),
      next_cursor: lastHit?.sort ? SearchService.encodeCursor(lastHit.sort) : null,
    };
  }

  /** The cursor is just the previous page's last sort values, base64'd. */
  private static encodeCursor(sort: SortCursor): string {
    return Buffer.from(JSON.stringify(sort), 'utf8').toString('base64url');
  }

  private static decodeCursor(cursor: string | undefined): SortCursor | null {
    if (cursor === undefined || cursor.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      return Array.isArray(parsed) ? (parsed as SortCursor) : null;
    } catch {
      throw new Error('after cursor is not valid — pass back the next_cursor value verbatim');
    }
  }
}
