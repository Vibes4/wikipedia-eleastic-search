import type { estypes } from '@elastic/elasticsearch';

export interface BooleanQuerySpec {
  /** Every clause must match, and each contributes to the score. */
  must?: string[];
  /** Optional clauses — matching lifts the score, missing costs nothing. */
  should?: string[];
  /** Documents matching any of these are excluded. */
  mustNot?: string[];
  /** Exact category values. Filters do not score and are cacheable. */
  categories?: string[];
}

/**
 * Every query shape the application can issue, in one place.
 *
 * Separated from SearchService so that execution (paging, highlighting,
 * response mapping) stays readable, and — more importantly — so that
 * `explain` provably scores a document with the same query `search` ran.
 * A builder returning a plain object is trivial to compare in a test; a query
 * assembled inline inside a request handler is not.
 */
export class QueryBuilder {
  /**
   * Field weights. Every number here is a hypothesis, and the relevance
   * harness exists to test it:
   *   title     an article named for the query is nearly always the target
   *   redirect  alternate titles are how people actually refer to things
   *   opening   a term in the lead means the article is ABOUT it
   */
  static readonly WEIGHTED_FIELDS = [
    'title^3',
    'redirect^2.5',
    'short_description^2',
    'opening_text^1.5',
    'headings^1.2',
    'text',
  ];

  /**
   * best_fields takes the single highest-scoring field rather than summing
   * across them. Summing would let a long article mentioning "tectonics" forty
   * times in the body outrank the article actually titled "Plate tectonics".
   */
  static multiMatch(q: string): estypes.QueryDslQueryContainer {
    return {
      multi_match: { query: q, fields: QueryBuilder.WEIGHTED_FIELDS, type: 'best_fields' },
    };
  }

  /** Single-field match — the baseline the weighted query is measured against. */
  static match(q: string, field: string): estypes.QueryDslQueryContainer {
    return { match: { [field]: { query: q } } };
  }

  /** Terms must be adjacent and in order. Requires positions in the index. */
  static phrase(q: string, field: string): estypes.QueryDslQueryContainer {
    return { match_phrase: { [field]: { query: q } } };
  }

  /**
   * Edit-distance matching. `AUTO` means: 0 edits allowed for terms of 1-2
   * characters, 1 for 3-5, 2 for longer — because one typo in a short word
   * usually makes it a different word.
   *
   * `prefix_length: 1` freezes the first character. It cuts the number of
   * candidate terms enormously (the term dictionary is sorted, so a fixed
   * prefix bounds the scan) and rarely hurts quality, since people typo the
   * middle of words far more than the start.
   */
  static fuzzy(q: string): estypes.QueryDslQueryContainer {
    return {
      multi_match: {
        query: q,
        fields: QueryBuilder.WEIGHTED_FIELDS,
        type: 'best_fields',
        fuzziness: 'AUTO',
        prefix_length: 1,
        max_expansions: 50,
      },
    };
  }

  /**
   * "plate tec" -> matches "plate tectonics".
   *
   * The last term becomes a prefix query, earlier terms must match as a phrase.
   * Note what this costs: the final term expands to every dictionary term
   * sharing its prefix, at query time, with no supporting structure. It is the
   * honest comparison point for the completion suggester, which precomputes an
   * FST at index time instead.
   */
  static phrasePrefix(q: string, field = 'title'): estypes.QueryDslQueryContainer {
    return { match_phrase_prefix: { [field]: { query: q, max_expansions: 50 } } };
  }

  /**
   * The four bool clause types, which differ in two independent ways: whether
   * a clause is required, and whether it scores.
   *
   *   must      required, scores
   *   should    optional, scores
   *   must_not  excluded, no score
   *   filter    required, NO score — and therefore cacheable
   *
   * Categories go in `filter` because "is this article in Category:Geology" is
   * a yes/no fact. Scoring it would be meaningless, and skipping the scoring
   * lets Elasticsearch reuse a cached bitset across requests.
   */
  static boolean(spec: BooleanQuerySpec): estypes.QueryDslQueryContainer {
    const must = (spec.must ?? []).map((term) => QueryBuilder.multiMatch(term));
    const should = (spec.should ?? []).map((term) => QueryBuilder.multiMatch(term));
    const mustNot = (spec.mustNot ?? []).map((term) => QueryBuilder.multiMatch(term));
    const filter: estypes.QueryDslQueryContainer[] = (spec.categories ?? []).map((category) => ({
      term: { 'categories.keyword': category },
    }));

    return {
      bool: {
        ...(must.length > 0 ? { must } : {}),
        ...(should.length > 0 ? { should } : {}),
        ...(mustNot.length > 0 ? { must_not: mustNot } : {}),
        ...(filter.length > 0 ? { filter } : {}),
        // With only `should` clauses, at least one has to match or every
        // document in the index would qualify.
        ...(must.length === 0 && filter.length === 0 && should.length > 0
          ? { minimum_should_match: 1 }
          : {}),
      },
    };
  }

  /**
   * Highlighting configuration.
   *
   * The unified highlighter reanalyses the stored field at query time to locate
   * matches, so this costs nothing at index time — but only for the handful of
   * documents in the fetch phase, never for the whole result set.
   */
  static highlight(): NonNullable<estypes.SearchRequest['highlight']> {
    return {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        title: { number_of_fragments: 0 },
        opening_text: { number_of_fragments: 1, fragment_size: 200 },
        text: { number_of_fragments: 2, fragment_size: 160 },
      },
    };
  }
}
