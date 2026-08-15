/**
 * Phase 1, passes 1 and 2: XML dump -> cleaned JSONL. No Elasticsearch needed.
 *
 *   npm run corpus -- <dump.xml> [--out data/wikipedia.jsonl] [--limit N]
 *
 * Start with `--limit 200` to eyeball the output before committing to the full
 * run.
 */
import { CorpusBuilder } from '../ingestion/CorpusBuilder.js';
import { Cli } from './Cli.js';

const cli = new Cli();
const dumpPath =
  cli.positional(0) ?? Cli.fail('usage: npm run corpus -- <dump.xml> [--out FILE] [--limit N]');

const outPath = cli.flag('out', 'data/wikipedia.jsonl');
const limit = cli.number('limit', Number.POSITIVE_INFINITY);

const started = Date.now();
const elapsed = (): string => ((Date.now() - started) / 1000).toFixed(0);

const builder = new CorpusBuilder(dumpPath, outPath, {
  limit,
  onProgress: (written) => console.log(`          ${written} docs  (${elapsed()}s)`),
});

console.log('pass 1/2  collecting redirects');
const redirects = await builder.collectRedirects();
console.log(
  `          ${redirects.total} stubs -> ${redirects.targetCount} target articles  (${elapsed()}s)\n`,
);

console.log(`pass 2/2  cleaning wikitext -> ${outPath}`);
const stats = await builder.build(redirects);

console.log(`
--- done in ${stats.seconds.toFixed(0)}s ---
articles seen   ${stats.articlesSeen}
written         ${stats.written}
skipped         ${stats.skipped}   (rendered to under 100 chars of prose)
failed          ${stats.failed}
with redirects  ${stats.withRedirects}
output          ${outPath}  (${(stats.bytes / 1e6).toFixed(0)} MB)`);
