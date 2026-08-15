/**
 * Rebuild the index from the cached corpus — no XML, no re-parsing.
 *
 *   npm run reindex -- --index wikipedia_v2
 *
 * This is the payoff for two Phase 1 decisions. The JSONL means a mapping
 * change costs ~25 seconds instead of ~200; the alias means the running API
 * picks up the new index without a restart and without a moment of downtime.
 *
 * The old index is left in place. Delete it once you have compared the two:
 *   curl -X DELETE localhost:9200/wikipedia_v1
 */
import { SearchCluster } from '../es/SearchCluster.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { JsonlCorpus } from '../ingestion/JsonlCorpus.js';
import { BulkIndexer } from '../ingestion/BulkIndexer.js';
import { DocumentTransform } from '../ingestion/DocumentTransform.js';
import { Cli } from './Cli.js';
import type { IndexedDocument } from '../types.js';

const cli = new Cli();
const filePath = cli.flag('file', 'data/wikipedia.jsonl');
const indexName = cli.flag('index') ?? Cli.fail('usage: npm run reindex -- --index wikipedia_v2');
const limit = cli.number('limit', Number.POSITIVE_INFINITY);

const corpus = new JsonlCorpus(filePath, limit);
if (!corpus.exists()) {
  Cli.fail(`missing ${filePath} — run \`npm run ingest\` first`);
}

const cluster = new SearchCluster();
console.log(await cluster.describe());

const index = new WikipediaIndex(cluster.client, indexName);

// Where the alias points before we touch anything — worth printing, because
// this is the index the running API is serving from right now.
const aliasExists = await cluster.client.indices.existsAlias({ name: WikipediaIndex.ALIAS });
const before = aliasExists
  ? Object.keys(await cluster.client.indices.getAlias({ name: WikipediaIndex.ALIAS }))
  : [];
console.log(`alias ${WikipediaIndex.ALIAS} currently → ${before.join(', ') || 'nothing'}`);

console.log(`creating ${index.name} with the current mapping`);
await index.recreate();

const indexer = new BulkIndexer<IndexedDocument>(cluster.client, index);
const stats = await indexer.run(DocumentTransform.withSuggest(corpus.documents()));

console.log(`
--- reindexed in ${stats.seconds.toFixed(1)}s ---
documents     ${stats.total}   (${Math.round(stats.docsPerSecond)}/s)
failed        ${stats.failed}
count in ES   ${stats.countInEs}
index size    ${(stats.sizeBytes / 1e6).toFixed(0)} MB
segments      ${stats.segments}
alias         ${WikipediaIndex.ALIAS} → ${index.name}`);

if (stats.dropped.length > 0) {
  console.log(`\ndropped ${stats.dropped.length}:`);
  for (const doc of stats.dropped.slice(0, 10)) {
    console.log(`  ${doc.wikiId} ${doc.title ?? ''} [${doc.status}] ${doc.reason}`);
  }
}

await cluster.close();
