/**
 * Phase 1, pass 3: cleaned JSONL -> Elasticsearch.
 *
 *   npm run index -- [--file data/wikipedia.jsonl] [--index wikipedia_v1] [--limit N]
 *
 * Recreates the index from scratch, loads it, and repoints the `wikipedia`
 * alias. Safe to re-run: document ids come from MediaWiki page ids.
 */
import { SearchCluster } from '../es/SearchCluster.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { JsonlCorpus } from '../ingestion/JsonlCorpus.js';
import { BulkIndexer } from '../ingestion/BulkIndexer.js';
import { Cli } from './Cli.js';

const cli = new Cli();
const filePath = cli.flag('file', 'data/wikipedia.jsonl');
const indexName = cli.flag('index', WikipediaIndex.DEFAULT_NAME);
const limit = cli.number('limit', Number.POSITIVE_INFINITY);

const corpus = new JsonlCorpus(filePath, limit);
if (!corpus.exists()) {
  Cli.fail(`missing ${filePath} — run \`npm run corpus\` first`);
}

const cluster = new SearchCluster();
console.log(await cluster.describe());

const index = new WikipediaIndex(cluster.client, indexName);
console.log(`creating ${index.name} (alias: ${index.alias})`);
await index.recreate();

const indexer = new BulkIndexer(cluster.client, index);
const stats = await indexer.run(corpus.documents());

console.log(`
--- indexed in ${stats.seconds.toFixed(1)}s ---
documents     ${stats.total}   (${Math.round(stats.docsPerSecond)}/s)
failed        ${stats.failed}
retried       ${stats.retried}
count in ES   ${stats.countInEs}
index size    ${(stats.sizeBytes / 1e6).toFixed(0)} MB
segments      ${stats.segments}`);

if (stats.dropped.length > 0) {
  console.log(`\ndropped ${stats.dropped.length}:`);
  for (const doc of stats.dropped.slice(0, 10)) {
    console.log(`  ${doc.wikiId} ${doc.title ?? ''} [${doc.status}] ${doc.reason}`);
  }
}

await cluster.close();
