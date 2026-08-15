import type { IndexedDocument, WikiDocument } from '../types.js';

/**
 * Fields derived at index time rather than stored in the corpus.
 *
 * Anything cheap to compute from what the JSONL already holds belongs here.
 * The cache then stays a faithful record of *the dump*, and adding a new
 * searchable structure costs a reindex (~25s) instead of a re-parse (~200s).
 */
export class DocumentTransform {
  /** Completion weights are capped so one heavily-aliased article can't dominate. */
  private static readonly MAX_WEIGHT = 100;

  /**
   * Build the autocomplete entry for one article.
   *
   * Inputs are the title plus every redirect pointing at it, so typing "NYC"
   * can surface "New York City" — the redirect titles are the whole reason
   * pass 1 of the ingest exists.
   *
   * Weight uses the redirect count as a rough popularity signal: an article
   * people refer to by many names is more likely to be the one they want.
   */
  static addSuggest(document: WikiDocument): IndexedDocument {
    const inputs = [document.title, ...document.redirect]
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 50);

    return {
      ...document,
      title_suggest: {
        input: [...new Set(inputs)],
        weight: Math.min(DocumentTransform.MAX_WEIGHT, 1 + document.redirect.length),
      },
    };
  }

  /** Apply addSuggest across a stream without materialising it. */
  static async *withSuggest(
    documents: AsyncIterable<WikiDocument>,
  ): AsyncGenerator<IndexedDocument> {
    for await (const document of documents) {
      yield DocumentTransform.addSuggest(document);
    }
  }
}
