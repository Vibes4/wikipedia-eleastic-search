/**
 * Score a search configuration against the judgment set.
 *
 *   npm run relevance
 *   npm run relevance -- --strategy simple     # the unweighted baseline
 *   npm run relevance -- --strategy fuzzy
 *
 * Read the deltas, not the absolutes. Run it, change one boost in
 * QueryBuilder.WEIGHTED_FIELDS, run it again — that difference is the only
 * honest evidence that a change helped.
 */
import fs from 'node:fs';
import { SearchCluster } from '../es/SearchCluster.js';
import { SearchService } from '../search/SearchService.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { RelevanceHarness } from '../relevance/RelevanceHarness.js';
import { Cli } from './Cli.js';
import type { JudgmentFile, Strategy } from '../relevance/RelevanceHarness.js';

const cli = new Cli();
const filePath = cli.flag('file', 'relevance/judgments.json');
const indexName = cli.flag('index', WikipediaIndex.ALIAS);
const strategy = cli.flag('strategy', 'weighted') as Strategy;

if (!fs.existsSync(filePath)) Cli.fail(`missing ${filePath}`);
const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as JudgmentFile;

const cluster = new SearchCluster();
const search = new SearchService(cluster.client, indexName);
const harness = new RelevanceHarness(search, cluster.client, indexName);

const report = await harness.run(file, strategy);

const pad = (value: string, width: number): string => value.padEnd(width).slice(0, width);
const pct = (value: number): string => value.toFixed(3).padStart(6);

console.log(`\nindex ${indexName} · strategy ${report.strategy} · k=${report.k}\n`);
console.log(`${pad('QUERY', 26)} ${pad('P@k', 6)} ${pad('R@k', 6)} ${pad('RR', 6)} ${pad('nDCG', 6)}  TOP RESULT`);
console.log('-'.repeat(100));

for (const q of report.queries) {
  console.log(
    `${pad(q.query, 26)} ${pct(q.precision)} ${pct(q.recall)} ${pct(q.reciprocalRank)} ${pct(q.ndcg)}  ${q.returned[0] ?? '—'}`,
  );
}

console.log('-'.repeat(100));
console.log(
  `${pad('MEAN', 26)} ${pct(report.meanPrecision)} ${pct(report.meanRecall)} ${pct(report.mrr)} ${pct(report.meanNdcg)}`,
);

const withMissing = report.queries.filter((q) => q.missing.length > 0);
if (withMissing.length > 0) {
  console.log(`\nMISSING — judged titles that do not exist in this index:`);
  for (const q of withMissing) {
    console.log(`  ${pad(q.query, 26)} ${q.missing.join(', ')}`);
  }
  console.log(`\n  Recall cannot reach 1.0 while these are judged. Replace them using:`);
  console.log(`  npm run judge -- "${withMissing[0]?.query ?? 'your query'}"`);
}

await cluster.close();
