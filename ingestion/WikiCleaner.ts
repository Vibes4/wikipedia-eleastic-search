import wtf from 'wtf_wikipedia';
import type { RedirectIndex } from './RedirectIndex.js';
import type { WikiDocument, WikiPage } from '../types.js';

/**
 * wtf_wikipedia's bundled .d.ts declares `Document.links()` as `string[]`, but
 * at runtime it returns Link objects. We describe only the method we call.
 */
interface WikiLinkLike {
  page(): string | undefined;
}

export interface WikiCleanerOptions {
  /**
   * Cap on outgoing links per document. A large article can cite well over a
   * thousand pages; this field exists for filtering and link analysis, not
   * full-text search, so an unbounded list mostly just inflates the index.
   */
  maxLinks?: number;
  /** Documents rendering to less prose than this are treated as empty. */
  minTextLength?: number;
  /** Character budget for the extracted lead paragraph. */
  openingTextLimit?: number;
}

/**
 * Turns a parsed WikiPage into the document we actually index.
 *
 * The dump's <text> is wikitext, not prose: templates, {{sfn}} citations,
 * [[links]], infoboxes, tables. Indexing it raw means a search for "sfn"
 * matches half of Wikipedia and every snippet comes back full of braces.
 * wtf_wikipedia renders it to plain text and hands us the structure
 * (categories, section titles, links) as a side effect.
 */
export class WikiCleaner {
  /**
   * {{Short description|Political philosophy and movement}} — a one-line gloss
   * Wikipedia editors maintain by hand. wtf_wikipedia strips it along with the
   * other templates, so it has to come off the raw wikitext first.
   */
  private static readonly SHORT_DESCRIPTION = /\{\{\s*short description\s*\|\s*([^}|]+)/i;

  private static readonly WIKI_BASE = 'https://en.wikipedia.org/wiki/';

  private readonly maxLinks: number;
  private readonly minTextLength: number;
  private readonly openingTextLimit: number;

  constructor(options: WikiCleanerOptions = {}) {
    this.maxLinks = options.maxLinks ?? 1000;
    this.minTextLength = options.minTextLength ?? 100;
    this.openingTextLimit = options.openingTextLimit ?? 600;
  }

  static articleUrl(title: string): string {
    return WikiCleaner.WIKI_BASE + encodeURIComponent(title.replace(/ /g, '_'));
  }

  /**
   * @returns the document to index, or null when there is nothing worth indexing
   *          (template-only pages, empty stubs).
   */
  toDocument(page: WikiPage, redirects?: RedirectIndex): WikiDocument | null {
    const wikitext = page.revision?.text;
    if (!wikitext || page.id === null) return null;

    const doc = wtf(wikitext, { title: page.title });
    const text = doc.text().trim();
    if (text.length < this.minTextLength) return null;

    const shortDescription =
      WikiCleaner.SHORT_DESCRIPTION.exec(wikitext)?.[1]?.trim() ?? null;

    const links = doc.links() as unknown as WikiLinkLike[];
    const outgoingLinks = [
      ...new Set(
        links
          .map((link) => link.page())
          .filter((title): title is string => typeof title === 'string' && title.length > 0),
      ),
    ].slice(0, this.maxLinks);

    const headings = [
      ...new Set(
        doc
          .sections()
          .map((section) => section.title())
          .filter((title): title is string => typeof title === 'string' && title.length > 0),
      ),
    ];

    const contributor = page.revision?.contributor ?? null;

    return {
      wiki_id: page.id,
      title: page.title,
      text,
      opening_text: this.openingText(text),
      short_description: shortDescription,
      categories: [...new Set(doc.categories().filter(Boolean))],
      headings,
      outgoing_links: outgoingLinks,
      redirect: redirects?.titlesFor(page.title) ?? [],
      namespace: page.ns ?? 0,
      url: WikiCleaner.articleUrl(page.title),
      revision_id: page.revision?.id ?? null,
      timestamp: page.revision?.timestamp ?? null,
      contributor: contributor?.username ?? contributor?.ip ?? null,
      text_bytes: page.revision?.textBytes ?? null,
      word_count: text.split(/\s+/).length,
    };
  }

  /**
   * First substantial paragraph — the lead. Worth storing separately: a term in
   * the lead means the article is *about* that term rather than merely
   * mentioning it, which makes this both a better snippet and a better boost.
   */
  private openingText(text: string): string {
    for (const paragraph of text.split('\n\n')) {
      const trimmed = paragraph.trim();
      if (trimmed.length > 80) {
        return trimmed.length > this.openingTextLimit
          ? trimmed.slice(0, this.openingTextLimit).trimEnd() + '…'
          : trimmed;
      }
    }
    return text.slice(0, this.openingTextLimit).trim();
  }
}
