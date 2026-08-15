/**
 * Flattens Elasticsearch's `_explain` tree into the numbers that actually
 * decide a ranking.
 *
 * The raw explanation is a deeply nested structure of "sum of:" / "result of:"
 * nodes. Buried in it, per matched term, are the three quantities BM25 is built
 * from:
 *
 *   idf  — how rare the term is across the corpus (rare terms count for more)
 *   tf   — how often it occurs in THIS document, saturating (k1) and
 *          normalised by field length against the average (b)
 *   boost— the per-field multiplier you set, e.g. title^3
 *
 * This turns "I found 500 documents" into "this one is first because 'tectonics'
 * is rare (idf 6.2) and appears in a short title field".
 */

/** Structural view of an explanation node; matches what ES returns. */
export interface ExplanationNode {
  value: number;
  description: string;
  details?: ExplanationNode[];
}

export interface TermExplanation {
  field: string;
  term: string;
  /** This term's contribution to the document's total score. */
  score: number;
  idf: number | null;
  tf: number | null;
  boost: number | null;
  /** Documents containing the term (n). */
  docFreq: number | null;
  /** Documents with this field (N). */
  docCount: number | null;
  /** Occurrences of the term in this document (freq). */
  termFreq: number | null;
  /** Length of this field in this document (dl). */
  fieldLength: number | null;
  /** Average field length across the corpus (avgdl). */
  avgFieldLength: number | null;
}

export interface ScoreBreakdown {
  score: number;
  terms: TermExplanation[];
}

export class BM25Explainer {
  /** `weight(title:tectonics in 42) [PerFieldSimilarity], result of:` */
  private static readonly WEIGHT = /^weight\(([^:]+):(.+?) in \d+\)/;

  static summarize(explanation: ExplanationNode | undefined): ScoreBreakdown {
    if (!explanation) return { score: 0, terms: [] };

    const weights: ExplanationNode[] = [];
    BM25Explainer.collectWeights(explanation, weights);

    const terms = weights
      .map((node) => BM25Explainer.describeTerm(node))
      .filter((term): term is TermExplanation => term !== null)
      // Biggest contributor first — that is the answer to "why this document?"
      .sort((a, b) => b.score - a.score);

    return { score: explanation.value, terms };
  }

  /** Depth-first walk collecting every per-term weight node. */
  private static collectWeights(node: ExplanationNode, out: ExplanationNode[]): void {
    if (BM25Explainer.WEIGHT.test(node.description)) {
      out.push(node);
      return; // everything below belongs to this term
    }
    for (const child of node.details ?? []) {
      BM25Explainer.collectWeights(child, out);
    }
  }

  private static describeTerm(node: ExplanationNode): TermExplanation | null {
    const match = BM25Explainer.WEIGHT.exec(node.description);
    if (match === null) return null;

    const field = match[1] ?? '';
    const term = match[2] ?? '';

    const idfNode = BM25Explainer.find(node, (d) => d.startsWith('idf'));
    const tfNode = BM25Explainer.find(node, (d) => d.startsWith('tf'));

    return {
      field,
      term,
      score: node.value,
      idf: idfNode?.value ?? null,
      tf: tfNode?.value ?? null,
      boost: BM25Explainer.valueOf(node, 'boost'),
      docFreq: idfNode ? BM25Explainer.valueOf(idfNode, 'n,') : null,
      docCount: idfNode ? BM25Explainer.valueOf(idfNode, 'N,') : null,
      termFreq: tfNode ? BM25Explainer.valueOf(tfNode, 'freq,') : null,
      fieldLength: tfNode ? BM25Explainer.valueOf(tfNode, 'dl,') : null,
      avgFieldLength: tfNode ? BM25Explainer.valueOf(tfNode, 'avgdl,') : null,
    };
  }

  /** First descendant whose description satisfies `predicate`. */
  private static find(
    node: ExplanationNode,
    predicate: (description: string) => boolean,
  ): ExplanationNode | null {
    for (const child of node.details ?? []) {
      if (predicate(child.description)) return child;
      const found = BM25Explainer.find(child, predicate);
      if (found !== null) return found;
    }
    return null;
  }

  private static valueOf(node: ExplanationNode, prefix: string): number | null {
    const found = BM25Explainer.find(node, (description) => description.startsWith(prefix));
    return found?.value ?? null;
  }
}
