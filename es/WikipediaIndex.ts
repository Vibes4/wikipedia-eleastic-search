import type { Client, estypes } from '@elastic/elasticsearch';

export interface IndexPrimaryStats {
  sizeBytes: number;
  segments: number;
}

/**
 * The Wikipedia index: its settings, its mapping, and the operations we perform
 * on it.
 *
 * Note what is deliberately absent from the mapping: custom analyzers,
 * stemming, stop words, synonyms. Phase 1 runs on the stock `standard` analyzer,
 * so "running" does not match "run" and "the" is a term like any other. That is
 * the baseline. Phase 3 introduces a real analyzer, reindexes into v2 from the
 * cached JSONL and swaps the alias — making the improvement something you
 * measure rather than something you assume.
 */
export class WikipediaIndex {
  static readonly ALIAS = 'wikipedia';
  static readonly DEFAULT_NAME = 'wikipedia_v1';

  static readonly settings: estypes.IndicesIndexSettings = {
    // 21k documents on one node: more shards would add coordination overhead
    // and shrink each shard's term statistics, which BM25 depends on.
    number_of_shards: 1,
    // Nowhere to put a replica on a single node; leaving this at the default 1
    // would pin the index yellow forever.
    number_of_replicas: 0,
    // The bulk loader drops this to -1 for the duration of a load.
    refresh_interval: '1s',
  };

  static readonly mappings: estypes.MappingTypeMapping = {
    // Reject documents carrying fields we did not plan for rather than letting
    // Elasticsearch guess a type. A typo'd field name should be a loud error,
    // not a silently created field.
    dynamic: 'strict',
    properties: {
      wiki_id: { type: 'long' },

      title: {
        type: 'text',
        fields: {
          // Unstemmed copy, for ranking an exact title match above a body match.
          exact: { type: 'text', analyzer: 'standard' },
          // Sorting and aggregations need doc_values, which `text` lacks.
          keyword: { type: 'keyword', ignore_above: 512 },
        },
      },

      text: { type: 'text' },
      opening_text: { type: 'text' },
      short_description: { type: 'text' },

      categories: {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      headings: { type: 'text' },

      // Alternate titles folded in from redirect stubs.
      redirect: { type: 'text' },

      // Autocomplete. A `completion` field is not an inverted index at all —
      // Elasticsearch builds a finite state transducer from every input string
      // and holds it in memory, so a prefix lookup is a walk through a graph
      // rather than a scan of the term dictionary. That is why it needs its own
      // field type, and why adding it required a reindex.
      title_suggest: {
        type: 'completion',
        // `simple` lowercases and splits on non-letters; it keeps suggestions
        // close to what was typed rather than stemming them into something else.
        analyzer: 'simple',
        preserve_separators: true,
        preserve_position_increments: true,
        max_input_length: 50,
      },

      // Filtered and aggregated, never full-text searched.
      outgoing_links: { type: 'keyword', ignore_above: 512 },

      namespace: { type: 'byte' },
      // Returned in results but never queried, so skip the inverted index.
      url: { type: 'keyword', index: false },
      revision_id: { type: 'long', index: false },
      timestamp: { type: 'date' },
      contributor: { type: 'keyword', ignore_above: 256 },
      text_bytes: { type: 'integer' },
      word_count: { type: 'integer' },
    },
  };

  constructor(
    private readonly client: Client,
    readonly name: string = WikipediaIndex.DEFAULT_NAME,
    readonly alias: string = WikipediaIndex.ALIAS,
  ) {}

  async exists(): Promise<boolean> {
    return this.client.indices.exists({ index: this.name });
  }

  /** Drop and recreate the index, then point the alias at it. */
  async recreate(): Promise<void> {
    if (await this.exists()) {
      await this.client.indices.delete({ index: this.name });
    }
    await this.client.indices.create({
      index: this.name,
      settings: WikipediaIndex.settings,
      mappings: WikipediaIndex.mappings,
    });
    await this.pointAliasHere();
  }

  /**
   * Move the alias to this index in a single atomic request, so readers never
   * observe a moment where `wikipedia` resolves to nothing. This is the whole
   * mechanism behind zero-downtime reindexing.
   */
  async pointAliasHere(): Promise<void> {
    let current: estypes.IndicesGetAliasResponse = {};
    if (await this.client.indices.existsAlias({ name: this.alias })) {
      current = await this.client.indices.getAlias({ name: this.alias });
    }

    const actions: estypes.IndicesUpdateAliasesAction[] = Object.keys(current)
      .filter((index) => index !== this.name)
      .map((index) => ({ remove: { index, alias: this.alias } }));

    actions.push({ add: { index: this.name, alias: this.alias } });
    await this.client.indices.updateAliases({ actions });
  }

  async setRefreshInterval(value: string): Promise<void> {
    await this.client.indices.putSettings({
      index: this.name,
      settings: { refresh_interval: value },
    });
  }

  /** Force the in-memory buffer into a searchable Lucene segment. */
  async refresh(): Promise<void> {
    await this.client.indices.refresh({ index: this.name });
  }

  async count(): Promise<number> {
    const response = await this.client.count({ index: this.name });
    return response.count;
  }

  async primaryStats(): Promise<IndexPrimaryStats> {
    const response = await this.client.indices.stats({ index: this.name });
    const primaries = response.indices?.[this.name]?.primaries;
    return {
      sizeBytes: primaries?.store?.size_in_bytes ?? 0,
      segments: primaries?.segments?.count ?? 0,
    };
  }
}
