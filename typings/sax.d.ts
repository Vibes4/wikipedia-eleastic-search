/**
 * Minimal ambient types for `sax`.
 *
 * The package ships no types of its own. Rather than pulling in @types/sax we
 * declare exactly the surface this project uses — it keeps the dependency list
 * short and documents which parts of the SAX API the parser actually relies on.
 *
 * The default import is used deliberately: `sax` is CommonJS, and under Node's
 * ESM loader `import sax from 'sax'` always resolves to `module.exports`.
 */
declare module 'sax' {
  export interface SaxTag {
    name: string;
    attributes: Record<string, string>;
    isSelfClosing: boolean;
  }

  export interface SaxParserOptions {
    trim?: boolean;
    normalize?: boolean;
    lowercase?: boolean;
    xmlns?: boolean;
    position?: boolean;
    strictEntities?: boolean;
  }

  export interface SaxParser {
    onopentag: ((tag: SaxTag) => void) | null;
    onclosetag: ((name: string) => void) | null;
    ontext: ((text: string) => void) | null;
    oncdata: ((text: string) => void) | null;
    onerror: ((error: Error) => void) | null;
    onend: (() => void) | null;
    write(chunk: string): SaxParser;
    close(): SaxParser;
    resume(): SaxParser;
  }

  const sax: {
    parser(strict: boolean, options?: SaxParserOptions): SaxParser;
  };

  export default sax;
}
