/**
 * The redirect graph, inverted.
 *
 * A redirect stub ("Anarchist" -> "Anarchism") carries no content of its own,
 * only an alternate name for a real article. Those names are some of the most
 * valuable search terms in the corpus — nobody types "New York City", they type
 * "NYC" — so instead of indexing 6,254 empty stub documents we fold each stub's
 * title into the article it points at.
 *
 * Inverted because we look up by target: "given this article, what else is it
 * called?"
 */
export class RedirectIndex {
  private readonly byTarget = new Map<string, string[]>();
  private redirectCount = 0;

  /** Record that `source` redirects to `target`. */
  add(source: string, target: string): void {
    this.redirectCount += 1;
    const existing = this.byTarget.get(target);
    if (existing) existing.push(source);
    else this.byTarget.set(target, [source]);
  }

  /** Alternate titles for an article, or an empty array. */
  titlesFor(target: string): string[] {
    return this.byTarget.get(target) ?? [];
  }

  /** Number of redirect stubs recorded. */
  get total(): number {
    return this.redirectCount;
  }

  /** Number of distinct articles that have at least one redirect. */
  get targetCount(): number {
    return this.byTarget.size;
  }
}
