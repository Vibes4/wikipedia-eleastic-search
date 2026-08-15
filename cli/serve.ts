/**
 * Start the search API.
 *
 *   npm run serve                       # http://127.0.0.1:3000
 *   npm run serve -- --port 8080 --log
 *
 * Queries the `wikipedia` alias, not a concrete index, so a Phase 3 reindex and
 * alias swap is picked up without restarting the server.
 */
import { SearchCluster } from '../es/SearchCluster.js';
import { SearchService } from '../search/SearchService.js';
import { WikipediaIndex } from '../es/WikipediaIndex.js';
import { ApiServer } from '../api/ApiServer.js';
import { Cli } from './Cli.js';

const cli = new Cli();
const port = cli.number('port', 3000);
const indexName = cli.flag('index', WikipediaIndex.ALIAS);

const cluster = new SearchCluster();
console.log(await cluster.describe());

const search = new SearchService(cluster.client, indexName);
const summary = await search.summary();
console.log(`index ${summary.index}: ${summary.documents} docs, ${summary.segments} segments`);

const server = new ApiServer(cluster, search, { logger: cli.bool('log') });
const address = await server.listen(port);
console.log(`\nlistening on ${address}`);
console.log(`try: curl '${address}/search?q=plate+tectonics'`);

const shutdown = async (): Promise<void> => {
  await server.close();
  await cluster.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
