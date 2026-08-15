import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SearchCluster } from '../es/SearchCluster.js';
import type { SearchService } from '../search/SearchService.js';

interface SearchQuerystring {
  q?: string;
  from?: string;
  size?: string;
  field?: string;
  /** Any value turns highlighting on. */
  highlight?: string;
  /** next_cursor from a previous response — replaces `from`. */
  after?: string;
}

/** Repeatable parameters arrive as a string or an array of strings. */
type Repeatable = string | string[] | undefined;

interface BoolQuerystring extends SearchQuerystring {
  must?: Repeatable;
  should?: Repeatable;
  not?: Repeatable;
  category?: Repeatable;
}

interface IdParams {
  id: string;
}

export interface ApiServerOptions {
  logger?: boolean;
}

/**
 * HTTP surface over the corpus.
 *
 * Everything after ingestion happens here rather than in one-off scripts, so a
 * query can be run repeatedly, from a browser or curl, and compared against the
 * same query under a different strategy.
 *
 * The routes map onto the roadmap:
 *   /search          item 3  — multi_match with field boosts
 *   /search/simple   item 3  — single-field match, the baseline
 *   /search/phrase   item 3  — match_phrase
 *   /explain/:id     item 4  — BM25: why is this document ranked here?
 */
export class ApiServer {
  private readonly app: FastifyInstance;

  constructor(
    private readonly cluster: SearchCluster,
    private readonly search: SearchService,
    options: ApiServerOptions = {},
  ) {
    this.app = Fastify({ logger: options.logger ?? false });
    this.registerRoutes();
    this.registerErrorHandler();
  }

  private registerRoutes(): void {
    // Discoverability: hitting the root tells you what else exists.
    this.app.get('/', async () => ({
      endpoints: {
        'GET /health': 'cluster and index status',
        'GET /stats': 'document count, index size, segment count',
        'GET /search?q=&from=&size=&highlight=&after=': 'weighted multi_match across all fields',
        'GET /search/simple?q=&field=text': 'single-field match (baseline)',
        'GET /search/phrase?q=&field=text': 'match_phrase, order and adjacency matter',
        'GET /search/fuzzy?q=': 'edit-distance tolerant (fuzziness AUTO)',
        'GET /search/prefix?q=&field=title': 'match_phrase_prefix — expanded at query time',
        'GET /search/bool?must=&should=&not=&category=': 'repeat any parameter to add clauses',
        'GET /suggest?q=': 'autocomplete via the FST completion suggester',
        'GET /docs/:id': 'fetch one document by wiki_id',
        'GET /explain/:id?q=': 'BM25 breakdown for one document against a query',
      },
    }));

    this.app.get('/health', async () => ({
      cluster: await this.cluster.describe(),
      index: await this.search.summary(),
    }));

    this.app.get('/stats', async () => this.search.summary());

    this.app.get<{ Querystring: SearchQuerystring }>('/search', async (request) => {
      return this.search.search(ApiServer.searchParams(request.query));
    });

    this.app.get<{ Querystring: SearchQuerystring }>('/search/simple', async (request) => {
      const params = ApiServer.searchParams(request.query);
      return this.search.simple(params, request.query.field ?? 'text');
    });

    this.app.get<{ Querystring: SearchQuerystring }>('/search/phrase', async (request) => {
      const params = ApiServer.searchParams(request.query);
      return this.search.phrase(params, request.query.field ?? 'text');
    });

    // Item 6 — edit distance. "elastisearch" should still find "Elasticsearch".
    this.app.get<{ Querystring: SearchQuerystring }>('/search/fuzzy', async (request) => {
      return this.search.fuzzy(ApiServer.searchParams(request.query));
    });

    // Item 7, the slow half of the comparison: prefix matching with no
    // supporting structure, expanded at query time. Compare with /suggest.
    this.app.get<{ Querystring: SearchQuerystring }>('/search/prefix', async (request) => {
      const params = ApiServer.searchParams(request.query);
      return this.search.prefix(params, request.query.field ?? 'title');
    });

    // Item 5 — the four clause types. Repeat a parameter to add clauses:
    //   /search/bool?must=earthquake&must=india&not=fiction&category=Geology
    this.app.get<{ Querystring: BoolQuerystring }>('/search/bool', async (request) => {
      const { query } = request;
      const spec = {
        must: ApiServer.list(query.must),
        should: ApiServer.list(query.should),
        mustNot: ApiServer.list(query.not),
        categories: ApiServer.list(query.category),
      };

      if (spec.must.length + spec.should.length + spec.categories.length === 0) {
        throw new ApiError(
          400,
          'give at least one must, should or category, e.g. /search/bool?must=earthquake&not=fiction',
        );
      }

      return this.search.boolean(spec, {
        q: [...spec.must, ...spec.should].join(' '),
        from: ApiServer.toInt(query.from, 0),
        size: ApiServer.toInt(query.size, 10),
        highlight: query.highlight !== undefined,
        after: query.after,
      });
    });

    // Item 7, the fast half: an FST walk, built at index time.
    this.app.get<{ Querystring: SearchQuerystring }>('/suggest', async (request) => {
      const q = request.query.q?.trim();
      if (!q) throw new ApiError(400, 'q is required, e.g. /suggest?q=plate tec');
      const started = Date.now();
      const suggestions = await this.search.suggest(q, ApiServer.toInt(request.query.size, 10));
      return { prefix: q, took_ms: Date.now() - started, suggestions };
    });

    this.app.get<{ Params: IdParams }>('/docs/:id', async (request, reply) => {
      const wikiId = ApiServer.toInt(request.params.id, NaN);
      if (Number.isNaN(wikiId)) throw new ApiError(400, 'id must be a number');

      const document = await this.search.byId(wikiId);
      if (document === null) return reply.code(404).send({ error: `no document ${wikiId}` });
      return document;
    });

    this.app.get<{ Params: IdParams; Querystring: SearchQuerystring }>(
      '/explain/:id',
      async (request) => {
        const wikiId = ApiServer.toInt(request.params.id, NaN);
        if (Number.isNaN(wikiId)) throw new ApiError(400, 'id must be a number');

        const q = request.query.q?.trim();
        if (!q) throw new ApiError(400, 'q is required');

        return this.search.explain(wikiId, q);
      },
    );
  }

  private registerErrorHandler(): void {
    this.app.setErrorHandler((error: any, _request, reply) => {
      const status = error instanceof ApiError ? error.status : 500;
      // Elasticsearch errors carry their own status; surface it rather than 500.
      const esStatus = (error as { statusCode?: number }).statusCode;
      reply.code(status === 500 && esStatus ? esStatus : status).send({
        error: error.message,
      });
    });
  }

  private static searchParams(query: SearchQuerystring): {
    q: string;
    from: number;
    size: number;
    highlight: boolean;
    after: string | undefined;
  } {
    const q = query.q?.trim();
    if (!q) throw new ApiError(400, 'q is required, e.g. /search?q=plate tectonics');
    return {
      q,
      from: ApiServer.toInt(query.from, 0),
      size: ApiServer.toInt(query.size, 10),
      highlight: query.highlight !== undefined,
      after: query.after,
    };
  }

  /** `?must=a&must=b` arrives as an array; `?must=a` as a bare string. */
  private static list(value: Repeatable): string[] {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter((v) => v.length > 0);
  }

  private static toInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) ? fallback : value;
  }

  async listen(port: number, host = '127.0.0.1'): Promise<string> {
    return this.app.listen({ port, host });
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
