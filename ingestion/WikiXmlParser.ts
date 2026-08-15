import fs from 'node:fs';
import sax from 'sax';
import type { SaxTag } from 'sax';
import type { WikiContributor, WikiPage, WikiRevision } from '../types.js';

/**
 * Assembles one WikiPage at a time from a stream of SAX events.
 *
 * Kept separate from the parser so that all mutable parse state lives in a
 * short-lived object: a new assembler per parse run means two concurrent
 * iterations can never corrupt each other's half-built page.
 */
class PageAssembler {
  /**
   * Text-bearing elements we keep, addressed by their path relative to <page>.
   * Paths rather than tag names because <id> means three different things
   * depending on nesting: page id, revision id, contributor id.
   */
  private static readonly TEXT_LEAVES: ReadonlySet<string> = new Set([
    'title',
    'ns',
    'id',
    'revision/id',
    'revision/parentid',
    'revision/timestamp',
    'revision/comment',
    'revision/model',
    'revision/format',
    'revision/origin',
    'revision/sha1',
    'revision/text',
    'revision/contributor/username',
    'revision/contributor/id',
    'revision/contributor/ip',
  ]);

  private page: WikiPage | null = null;
  private revision: WikiRevision | null = null;
  /** Element names inside <page>, excluding <page> itself. */
  private stack: string[] = [];
  /** Accumulator for the current text leaf; null when not inside one. */
  private chars: string[] | null = null;

  constructor(private readonly emit: (page: WikiPage) => void) {}

  private static emptyContributor(): WikiContributor {
    return { username: null, id: null, ip: null, deleted: false };
  }

  private static emptyRevision(): WikiRevision {
    return {
      id: null,
      parentId: null,
      timestamp: null,
      minor: false,
      comment: null,
      model: null,
      format: null,
      origin: null,
      sha1: null,
      text: '',
      textBytes: null,
      contributor: PageAssembler.emptyContributor(),
    };
  }

  private static emptyPage(): WikiPage {
    return { id: null, title: '', ns: null, redirect: null, revision: null };
  }

  private static toInt(value: string | null): number | null {
    if (value === null || value === '') return null;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }

  openTag(tag: SaxTag): void {
    if (this.page === null) {
      // Outside a page the only interesting event is the next <page>.
      if (tag.name === 'page') {
        this.page = PageAssembler.emptyPage();
        this.stack = [];
      }
      return;
    }

    this.stack.push(tag.name);
    const path = this.stack.join('/');

    switch (path) {
      case 'revision':
        this.revision = PageAssembler.emptyRevision();
        return;
      case 'redirect':
        // <redirect title="Target" /> — the target lives in the attribute
        this.page.redirect = tag.attributes['title'] ?? null;
        return;
      case 'revision/minor':
        if (this.revision) this.revision.minor = true;
        return;
      case 'revision/contributor':
        if (this.revision && tag.attributes['deleted'] !== undefined) {
          this.revision.contributor.deleted = true;
        }
        return;
      case 'revision/text':
        // byte length and hash are attributes, not content
        if (this.revision) {
          this.revision.textBytes = PageAssembler.toInt(tag.attributes['bytes'] ?? null);
          const sha1 = tag.attributes['sha1'];
          if (sha1) this.revision.sha1 = sha1;
        }
        break;
      default:
        break;
    }

    if (PageAssembler.TEXT_LEAVES.has(path)) this.chars = [];
  }

  appendText(text: string): void {
    // A 100 KB <text> node arrives as dozens of events; collect, join once.
    if (this.chars !== null) this.chars.push(text);
  }

  closeTag(): void {
    const page = this.page;
    if (page === null) return;

    if (this.stack.length === 0) {
      // </page>
      this.page = null;
      this.revision = null;
      this.emit(page);
      return;
    }

    const path = this.stack.join('/');
    this.stack.pop();

    const value = this.chars === null ? null : this.chars.join('');
    this.chars = null;

    const revision = this.revision;

    switch (path) {
      case 'title':
        page.title = value ?? '';
        break;
      case 'ns':
        page.ns = PageAssembler.toInt(value);
        break;
      case 'id':
        page.id = PageAssembler.toInt(value);
        break;

      case 'revision':
        // pages-articles dumps carry one revision per page; if a dump ever
        // carries several, the last one wins.
        page.revision = revision;
        this.revision = null;
        break;

      case 'revision/id':
        if (revision) revision.id = PageAssembler.toInt(value);
        break;
      case 'revision/parentid':
        if (revision) revision.parentId = PageAssembler.toInt(value);
        break;
      case 'revision/timestamp':
        if (revision) revision.timestamp = value;
        break;
      case 'revision/comment':
        if (revision) revision.comment = value;
        break;
      case 'revision/model':
        if (revision) revision.model = value;
        break;
      case 'revision/format':
        if (revision) revision.format = value;
        break;
      case 'revision/origin':
        if (revision) revision.origin = PageAssembler.toInt(value);
        break;
      case 'revision/sha1':
        if (revision) revision.sha1 = value;
        break;
      case 'revision/text':
        if (revision) revision.text = value ?? '';
        break;

      case 'revision/contributor/username':
        if (revision) revision.contributor.username = value;
        break;
      case 'revision/contributor/id':
        if (revision) revision.contributor.id = PageAssembler.toInt(value);
        break;
      case 'revision/contributor/ip':
        if (revision) revision.contributor.ip = value;
        break;

      default:
        // unknown element (restrictions, DiscussionThreading, ...) — ignore
        break;
    }
  }
}

/**
 * Completion/failure signalling between the SAX callbacks and the async
 * generator that drains them.
 *
 * This is a class rather than a handful of `let` flags on purpose: TypeScript's
 * control-flow narrowing is unreliable for locals that are only ever assigned
 * inside callbacks, and `signal.error` read through a getter is unambiguous at
 * every call site.
 */
class ParseSignal {
  private failure: Error | null = null;
  private done = false;
  private wakeup: (() => void) | null = null;

  get error(): Error | null {
    return this.failure;
  }

  get isDone(): boolean {
    return this.done;
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.done = true;
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  wake(): void {
    const resume = this.wakeup;
    this.wakeup = null;
    if (resume) resume();
  }

  /** Resolves when wake() is next called. */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeup = resolve;
    });
  }
}

export interface WikiXmlParserOptions {
  /** Parsed pages buffered before the file read is paused. */
  highWaterMark?: number;
  /** File read chunk size in bytes. */
  chunkSize?: number;
}

/**
 * Streaming parser for MediaWiki XML dumps (export schema 0.10 / 0.11).
 *
 * Memory stays flat regardless of dump size because the consumer sets the pace:
 * once `highWaterMark` pages are queued the underlying file stream pauses, so a
 * slow consumer (bulk-indexing over the network) throttles the reader instead of
 * letting parsed pages pile up in the heap.
 *
 *   const parser = new WikiXmlParser('enwiki-....xml');
 *   for await (const page of parser.pages()) { ... }
 */
export class WikiXmlParser {
  private static readonly DEFAULT_HIGH_WATER_MARK = 64;
  private static readonly DEFAULT_CHUNK_SIZE = 1 << 20;

  constructor(
    private readonly filePath: string,
    private readonly options: WikiXmlParserOptions = {},
  ) {}

  /** True for a real content page: main namespace, not a redirect stub. */
  static isArticle(page: WikiPage): boolean {
    return page.ns === 0 && page.redirect === null;
  }

  async *pages(): AsyncGenerator<WikiPage> {
    const highWaterMark = this.options.highWaterMark ?? WikiXmlParser.DEFAULT_HIGH_WATER_MARK;
    const chunkSize = this.options.chunkSize ?? WikiXmlParser.DEFAULT_CHUNK_SIZE;

    const file = fs.createReadStream(this.filePath, {
      encoding: 'utf8', // StringDecoder handles multi-byte chars split across chunks
      highWaterMark: chunkSize,
    });

    // Strict mode: fail loudly on malformed XML rather than guessing. Safe
    // because the dump escapes every non-XML entity (&nbsp; is &amp;nbsp;).
    const parser = sax.parser(true, { trim: false, normalize: false, position: false });

    const queue: WikiPage[] = [];
    const signal = new ParseSignal();

    const assembler = new PageAssembler((page) => {
      queue.push(page);
    });

    parser.onopentag = (tag) => assembler.openTag(tag);
    parser.ontext = (text) => assembler.appendText(text);
    parser.oncdata = (text) => assembler.appendText(text);
    parser.onclosetag = () => assembler.closeTag();

    parser.onerror = (err) => signal.fail(err);
    parser.onend = () => signal.finish();

    file.on('data', (chunk) => {
      if (signal.error) return;
      try {
        parser.write(chunk as string);
      } catch (err) {
        signal.fail(err as Error);
        return;
      }
      signal.wake();
      if (queue.length >= highWaterMark) file.pause();
    });

    file.on('end', () => {
      try {
        parser.close();
      } catch (err) {
        signal.fail(err as Error);
      }
    });

    file.on('error', (err) => signal.fail(err));

    try {
      for (;;) {
        const error = signal.error;
        if (error) throw error;

        const next = queue.shift();
        if (next !== undefined) {
          if (queue.length < highWaterMark / 2 && file.isPaused()) file.resume();
          yield next;
          continue;
        }

        if (signal.isDone) return;

        await signal.wait();
      }
    } finally {
      // covers early `break`/`return` in the consumer as well as normal completion
      file.destroy();
    }
  }
}
