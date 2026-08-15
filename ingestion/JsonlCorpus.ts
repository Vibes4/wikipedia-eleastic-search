import fs from 'node:fs';
import readline from 'node:readline';
import type { WikiDocument } from '../types.js';

/**
 * Reads the cleaned corpus back off disk, one document per line.
 *
 * This is the input to every reindex. Because it is a plain async iterable it
 * plugs straight into the bulk helper's datasource without ever holding more
 * than one document in memory.
 */
export class JsonlCorpus {
  constructor(
    private readonly filePath: string,
    private readonly limit: number = Number.POSITIVE_INFINITY,
  ) {}

  get path(): string {
    return this.filePath;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  async *documents(): AsyncGenerator<WikiDocument> {
    const input = fs.createReadStream(this.filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    let emitted = 0;
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        yield JSON.parse(line) as WikiDocument;
        emitted += 1;
        if (emitted >= this.limit) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
}
