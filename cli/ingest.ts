/**
 * The one command: XML dump -> cleaned JSONL -> index -> documents in Elasticsearch.
 *
 *   npm run ingest -- <dump.xml>
 *   npm run ingest -- <dump.xml> --limit 200        # fast end-to-end smoke test
 *   npm run ingest -- <dump.xml> --rebuild          # force a fresh JSONL
 *   npm run ingest -- <dump.xml> --index wikipedia_v2
 *
 * The JSONL is cached: a second run skips straight to creating the index and
 * loading it, which is what makes mapping and analyzer experiments cheap.
 */
import { SearchCluster } from '../es/SearchCluster.js';
import { IngestPipeline } from '../ingestion/IngestPipeline.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { Cli } from './Cli.js';

const cli = new Cli();
const dumpPath =
  cli.positional(0) ??
  Cli.fail('usage: npm run ingest -- <dump.xml> [--limit N] [--rebuild] [--index NAME]');

const cluster = new SearchCluster();
console.log(await cluster.describe());

const pipeline = new IngestPipeline(cluster, {
  dumpPath,
  corpusPath: cli.flag('out', 'data/wikipedia.jsonl'),
  indexName: cli.flag('index', WikipediaIndex.DEFAULT_NAME),
  limit: cli.number('limit', Number.POSITIVE_INFINITY),
  rebuildCorpus: cli.bool('rebuild'),
  onLog: (message) => console.log(message),
});

try {
  const report = await pipeline.run();
  const { bulk } = report;

  console.log(`
--- ingest complete in ${report.seconds.toFixed(0)}s ---
corpus        ${report.corpusPath}${report.corpusReused ? '  (reused)' : ''}
index         ${report.indexName}  (alias: ${WikipediaIndex.ALIAS})
documents     ${bulk.total}   (${Math.round(bulk.docsPerSecond)}/s)
failed        ${bulk.failed}
count in ES   ${bulk.countInEs}
index size    ${(bulk.sizeBytes / 1e6).toFixed(0)} MB
segments      ${bulk.segments}

next: npm run serve`);

  if (bulk.dropped.length > 0) {
    console.log(`\ndropped ${bulk.dropped.length}:`);
    for (const doc of bulk.dropped.slice(0, 10)) {
      console.log(`  ${doc.wikiId} ${doc.title ?? ''} [${doc.status}] ${doc.reason}`);
    }
  }
} finally {
  await cluster.close();
}
