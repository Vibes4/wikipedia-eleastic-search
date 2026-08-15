import type { Client } from '@elastic/elasticsearch';
import type { SearchService } from '../search/SearchService.js';

export interface Judgment {
  query: string;
  /** Article titles a good result set should contain, best first. */
  relevant: string[];
}

export interface JudgmentFile {
  note?: string;
  k?: number;
  judgments: Judgment[];
}

export interface QueryScore {
  query: string;
  returned: string[];
  relevantFound: number;
  relevantTotal: number;
  precision: number;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
  /** Judged titles that do not exist in the index at all. */
  missing: string[];
}

export interface HarnessReport {
  k: number;
  strategy: string;
  queries: QueryScore[];
  meanPrecision: number;
  meanRecall: number;
  mrr: number;
  meanNdcg: number;
}

export type Strategy = 'weighted' | 'simple' | 'fuzzy';

/**
 * Scores a search configuration against a set of human judgments.
 *
 * The point is not the absolute numbers — with a hand-written judgment set they
 * mean little on their own. The point is the *delta*: run it, change one boost
 * or one analyzer, run it again. Without this, "did that help?" has no answer
 * beyond spot-checking a few queries and trusting your memory.
 *
 * Titles rather than document ids, because a judgment set written by hand
 * should stay readable and survive a reindex.
 */
export class RelevanceHarness {
  constructor(
    private readonly search: SearchService,
    private readonly client: Client,
    private readonly index: string,
  ) {}

  async run(file: JudgmentFile, strategy: Strategy = 'weighted'): Promise<HarnessReport> {
    const k = file.k ?? 10;
    const queries: QueryScore[] = [];

    for (const judgment of file.judgments) {
      queries.push(await this.scoreOne(judgment, k, strategy));
    }

    const mean = (pick: (q: QueryScore) => number): number =>
      queries.length === 0 ? 0 : queries.reduce((sum, q) => sum + pick(q), 0) / queries.length;

    return {
      k,
      strategy,
      queries,
      meanPrecision: mean((q) => q.precision),
      meanRecall: mean((q) => q.recall),
      mrr: mean((q) => q.reciprocalRank),
      meanNdcg: mean((q) => q.ndcg),
    };
  }

  private async scoreOne(judgment: Judgment, k: number, strategy: Strategy): Promise<QueryScore> {
    const params = { q: judgment.query, size: k };
    const response =
      strategy === 'simple'
        ? await this.search.simple(params)
        : strategy === 'fuzzy'
          ? await this.search.fuzzy(params)
          : await this.search.search(params);

    const returned = response.hits.map((hit) => hit.title);
    const relevant = new Set(judgment.relevant.map(RelevanceHarness.normalize));
    const hitFlags = returned.map((title) => relevant.has(RelevanceHarness.normalize(title)));

    const relevantFound = hitFlags.filter(Boolean).length;
    const firstHitIndex = hitFlags.indexOf(true);

    return {
      query: judgment.query,
      returned,
      relevantFound,
      relevantTotal: judgment.relevant.length,
      // Of the k results we showed, how many were right?
      precision: returned.length === 0 ? 0 : relevantFound / returned.length,
      // Of the right answers that exist, how many did we surface?
      recall: judgment.relevant.length === 0 ? 0 : relevantFound / judgment.relevant.length,
      // How far down was the first good result? 1.0 means position one.
      reciprocalRank: firstHitIndex === -1 ? 0 : 1 / (firstHitIndex + 1),
      ndcg: RelevanceHarness.ndcg(hitFlags, judgment.relevant.length, k),
      missing: await this.missingTitles(judgment.relevant),
    };
  }

  /**
   * Normalised discounted cumulative gain, binary relevance.
   *
   * Precision ignores order; nDCG does not. A relevant document at rank 1 is
   * worth more than the same document at rank 8, discounted logarithmically —
   * which matches how people actually read a result page.
   */
  private static ndcg(hitFlags: boolean[], relevantTotal: number, k: number): number {
    const gain = (position: number): number => 1 / Math.log2(position + 2);

    const dcg = hitFlags
      .slice(0, k)
      .reduce((sum, isRelevant, i) => sum + (isRelevant ? gain(i) : 0), 0);

    // The best achievable ordering: every relevant document packed at the top.
    let ideal = 0;
    for (let i = 0; i < Math.min(relevantTotal, k); i += 1) ideal += gain(i);

    return ideal === 0 ? 0 : dcg / ideal;
  }

  /**
   * A judged title that is not in the corpus makes recall unreachable, and the
   * harness should say so rather than quietly reporting a bad score.
   */
  private async missingTitles(titles: string[]): Promise<string[]> {
    if (titles.length === 0) return [];

    const response = await this.client.search<{ title: string }>({
      index: this.index,
      size: titles.length,
      _source: ['title'],
      query: { terms: { 'title.keyword': titles } },
    });

    const present = new Set(
      response.hits.hits.map((hit) => RelevanceHarness.normalize(hit._source?.title ?? '')),
    );
    return titles.filter((title) => !present.has(RelevanceHarness.normalize(title)));
  }

  private static normalize(title: string): string {
    return title.trim().toLowerCase();
  }
}
