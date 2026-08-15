/**
 * Domain types shared across ingestion and search.
 *
 * Two distinct shapes live here and it is worth keeping them apart:
 *
 *   WikiPage     — what the XML dump gives us (wikitext, revision metadata)
 *   WikiDocument — what we put into Elasticsearch (clean prose, extracted structure)
 *
 * The cleaner is the only thing that turns one into the other.
 */

export interface WikiContributor {
  username: string | null;
  id: number | null;
  ip: string | null;
  deleted: boolean;
}

export interface WikiRevision {
  id: number | null;
  parentId: number | null;
  timestamp: string | null;
  minor: boolean;
  comment: string | null;
  model: string | null;
  format: string | null;
  origin: number | null;
  sha1: string | null;
  /** Raw wikitext. Never null — an absent <text> element yields ''. */
  text: string;
  textBytes: number | null;
  contributor: WikiContributor;
}

export interface WikiPage {
  id: number | null;
  title: string;
  /** MediaWiki namespace. 0 = article, 4 = Wikipedia:, 14 = Category:, ... */
  ns: number | null;
  /** Target title when this page is a redirect stub, otherwise null. */
  redirect: string | null;
  revision: WikiRevision | null;
}

/** The document shape indexed into Elasticsearch. Field names match the mapping. */
export interface WikiDocument {
  wiki_id: number;
  title: string;
  text: string;
  opening_text: string;
  short_description: string | null;
  categories: string[];
  headings: string[];
  outgoing_links: string[];
  /** Alternate titles, folded in from redirect stubs pointing at this article. */
  redirect: string[];
  namespace: number;
  url: string;
  revision_id: number | null;
  timestamp: string | null;
  contributor: string | null;
  text_bytes: number | null;
  word_count: number;
}

/**
 * Input for a `completion`-type field. Elasticsearch builds an FST from every
 * string in `input`, so an article is reachable by its title AND by any name
 * that redirects to it.
 */
export interface CompletionInput {
  input: string[];
  /** Ranks equally-matching suggestions. Higher wins. */
  weight: number;
}

/**
 * What is actually sent to Elasticsearch: the cleaned document plus fields
 * derived at index time.
 *
 * `title_suggest` deliberately lives here rather than in the JSONL. It is
 * cheap to derive from fields the corpus already has, and keeping it out of the
 * cache means adding autocomplete costs a reindex, not a re-parse of the dump.
 */
export interface IndexedDocument extends WikiDocument {
  title_suggest: CompletionInput;
}
