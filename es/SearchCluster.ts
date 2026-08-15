import { Client } from '@elastic/elasticsearch';

/**
 * Owns the connection to Elasticsearch.
 *
 * Everything else in the project takes a `Client` rather than reaching for a
 * module-level singleton, which keeps the pieces testable against a throwaway
 * cluster or a different node.
 */
export class SearchCluster {
  static readonly DEFAULT_NODE = 'http://localhost:9200';

  readonly client: Client;

  constructor(node: string = process.env['ES_NODE'] ?? SearchCluster.DEFAULT_NODE) {
    this.client = new Client({ node });
  }

  /** One-line banner: node name, server version, and the Lucene it runs on. */
  async describe(): Promise<string> {
    const info = await this.client.info();
    return `${info.name} · Elasticsearch ${info.version.number} · Lucene ${info.version.lucene_version}`;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
