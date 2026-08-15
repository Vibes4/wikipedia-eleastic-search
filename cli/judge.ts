/**
 * Find real titles to put in the judgment set.
 *
 *   npm run judge -- "plate tectonics"
 *   npm run judge -- "anarchism" --size 20
 *
 * Prints candidates from your actual index, then the JSON to paste into
 * relevance/judgments.json. Decide which are genuinely relevant yourself —
 * that judgement is the part a machine cannot supply, and it is what makes the
 * harness meaningful.
 */
import { SearchCluster } from '../es/SearchCluster.js';
import { SearchService } from '../search/SearchService.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { Cli } from './Cli.js';

const cli = new Cli();
const query = cli.positional(0) ?? Cli.fail('usage: npm run judge -- "your query" [--size 20]');
const size = cli.number('size', 15);
const indexName = cli.flag('index', WikipediaIndex.ALIAS);

const cluster = new SearchCluster();
const search = new SearchService(cluster.client, indexName);

const response = await search.search({ q: query, size });

console.log(`\n"${query}" — ${response.total} matches, showing ${response.hits.length}\n`);

for (const [i, hit] of response.hits.entries()) {
  const rank = String(i + 1).padStart(2);
  const score = hit.score.toFixed(2).padStart(7);
  const description = hit.short_description ?? hit.opening_text.slice(0, 70);
  console.log(`${rank}. ${score}  ${hit.title}`);
  console.log(`             ${description}`);
}

console.log(`\n--- paste into relevance/judgments.json, keeping only the relevant ones ---`);
console.log(
  JSON.stringify({ query, relevant: response.hits.slice(0, 5).map((h) => h.title) }, null, 2),
);

await cluster.close();
