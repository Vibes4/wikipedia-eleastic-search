/**
 * Sanity-check the XML parser against a dump — no Elasticsearch involved.
 *
 *   npm run inspect -- <dump.xml> [--limit N]
 *
 * Prints a sample redirect stub, a sample article, and corpus totals. The
 * namespace histogram is the quickest way to see what a dump actually contains
 * before you commit to indexing it.
 */
import { WikiXmlParser } from '../ingestion/WikiXmlParser.js';
import { Cli } from './Cli.js';
import type { WikiPage } from '../types.js';

const cli = new Cli();
// `Cli.fail` returns never, so the `??` leaves dumpPath narrowed to string.
const dumpPath = cli.positional(0) ?? Cli.fail('usage: npm run inspect -- <dump.xml> [--limit N]');

const limit = cli.number('limit', Number.POSITIVE_INFINITY);
const started = Date.now();

const byNamespace = new Map<number | null, number>();
let pages = 0;
let redirects = 0;
let articles = 0;
let wikitextChars = 0;
let sampleArticle: WikiPage | null = null;
let sampleRedirect: WikiPage | null = null;

const parser = new WikiXmlParser(dumpPath);

for await (const page of parser.pages()) {
  pages += 1;
  byNamespace.set(page.ns, (byNamespace.get(page.ns) ?? 0) + 1);
  wikitextChars += page.revision?.text.length ?? 0;

  if (page.redirect !== null) {
    redirects += 1;
    sampleRedirect ??= page;
  } else if (WikiXmlParser.isArticle(page)) {
    articles += 1;
    if ((page.revision?.text.length ?? 0) > 4000) sampleArticle ??= page;
  }

  if (pages >= limit) break;
  if (pages % 5000 === 0) process.stderr.write(`  ...${pages} pages\n`);
}

const seconds = (Date.now() - started) / 1000;

/** Trim the wikitext so the sample stays readable in a terminal. */
function preview(page: WikiPage | null): unknown {
  if (page === null) return null;
  if (page.revision === null) return page;
  const { text } = page.revision;
  return {
    ...page,
    revision: {
      ...page.revision,
      text: text.length > 300 ? `${text.slice(0, 300)} …` : text,
    },
  };
}

console.log('\n--- sample redirect ---');
console.dir(preview(sampleRedirect), { depth: null });
console.log('\n--- sample article ---');
console.dir(preview(sampleArticle), { depth: null });

const namespaces = Object.fromEntries(
  [...byNamespace]
    .sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1))
    .map(([ns, count]) => [ns === null ? 'none' : String(ns), count] as const),
);

console.log(`
--- totals ---
pages          ${pages}
redirects      ${redirects}
articles       ${articles}   (ns=0, not a redirect)
wikitext       ${(wikitextChars / 1e6).toFixed(1)} MB
namespaces     ${JSON.stringify(namespaces)}
elapsed        ${seconds.toFixed(1)}s  (${Math.round(pages / seconds)} pages/s)
peak rss       ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
