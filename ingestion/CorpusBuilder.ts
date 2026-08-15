import fs from 'node:fs';
import path from 'node:path';
import { WikiXmlParser } from './WikiXmlParser.js';
import { WikiCleaner } from './WikiCleaner.js';
import { RedirectIndex } from './RedirectIndex.js';
import type { WikiDocument } from '../types.js';

export interface CorpusBuilderOptions {
  /** Stop after this many documents. Useful for smoke tests. */
  limit?: number;
  cleaner?: WikiCleaner;
  /** Called every `progressEvery` documents written. */
  onProgress?: (written: number) => void;
  progressEvery?: number;
}

export interface CorpusBuildStats {
  redirects: number;
  redirectTargets: number;
  articlesSeen: number;
  written: number;
  /** Articles that rendered to too little prose to be worth indexing. */
  skipped: number;
  failed: number;
  withRedirects: number;
  bytes: number;
  seconds: number;
}

/**
 * XML dump -> cleaned JSONL, in two passes.
 *
 * Why an intermediate file rather than piping straight into Elasticsearch:
 * parsing and rendering 1 GB of wikitext costs minutes, and you will reindex
 * many times while experimenting with analyzers, mappings and boosts. Analyzer
 * choice in particular is baked into the inverted index at write time, so
 * "try stemming" means a full reindex. From this JSONL that takes about a
 * minute and never touches the XML again.
 *
 * Why two passes: a redirect stub can appear before OR after its target in the
 * dump, so every redirect has to be known before the first article is written.
 * Pass 1 reads titles only and is cheap.
 */
export class CorpusBuilder {
  private readonly cleaner: WikiCleaner;
  private readonly limit: number;
  private readonly progressEvery: number;

  constructor(
    private readonly dumpPath: string,
    private readonly outPath: string,
    private readonly options: CorpusBuilderOptions = {},
  ) {
    this.cleaner = options.cleaner ?? new WikiCleaner();
    this.limit = options.limit ?? Number.POSITIVE_INFINITY;
    this.progressEvery = options.progressEvery ?? 1000;
  }

  /** Pass 1 — collect every redirect stub, keyed by the article it targets. */
  async collectRedirects(): Promise<RedirectIndex> {
    const index = new RedirectIndex();
    const parser = new WikiXmlParser(this.dumpPath);

    for await (const page of parser.pages()) {
      if (page.redirect !== null) index.add(page.title, page.redirect);
    }
    return index;
  }

  /**
   * Pass 2 — clean every article and stream it to disk as JSONL.
   *
   * @param redirects result of pass 1; collected here if the caller omits it.
   */
  async build(redirects?: RedirectIndex): Promise<CorpusBuildStats> {
    const started = Date.now();
    const redirectIndex = redirects ?? (await this.collectRedirects());

    fs.mkdirSync(path.dirname(this.outPath), { recursive: true });
    const out = fs.createWriteStream(this.outPath, { encoding: 'utf8' });

    const stats: CorpusBuildStats = {
      redirects: redirectIndex.total,
      redirectTargets: redirectIndex.targetCount,
      articlesSeen: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      withRedirects: 0,
      bytes: 0,
      seconds: 0,
    };

    const parser = new WikiXmlParser(this.dumpPath);

    for await (const page of parser.pages()) {
      if (!WikiXmlParser.isArticle(page)) continue;
      stats.articlesSeen += 1;

      let document: WikiDocument | null;
      try {
        document = this.cleaner.toDocument(page, redirectIndex);
      } catch {
        stats.failed += 1;
        continue;
      }

      if (document === null) {
        stats.skipped += 1;
        continue;
      }

      if (document.redirect.length > 0) stats.withRedirects += 1;

      const line = JSON.stringify(document) + '\n';
      stats.bytes += Buffer.byteLength(line);
      await CorpusBuilder.write(out, line);
      stats.written += 1;

      if (stats.written % this.progressEvery === 0) {
        this.options.onProgress?.(stats.written);
      }
      if (stats.written >= this.limit) break;
    }

    await new Promise<void>((resolve) => out.end(resolve));

    stats.seconds = (Date.now() - started) / 1000;
    return stats;
  }

  /** Respect the write stream's backpressure instead of buffering in memory. */
  private static write(stream: fs.WriteStream, line: string): Promise<void> {
    if (stream.write(line)) return Promise.resolve();
    return new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}
