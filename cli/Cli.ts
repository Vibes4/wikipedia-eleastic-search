/**
 * Minimal argument parsing shared by the command-line entry points.
 *
 * Deliberately tiny — the project's interesting parts are the ingest and the
 * queries, not option handling. Supports `--flag value`, bare `--flag`, and
 * positional arguments.
 */
export class Cli {
  private readonly flagValues = new Map<string, string>();
  private readonly positionalValues: string[] = [];

  constructor(argv: string[] = process.argv.slice(2)) {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === undefined) continue;

      if (!arg.startsWith('--')) {
        this.positionalValues.push(arg);
        continue;
      }

      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        this.flagValues.set(name, next);
        i += 1;
      } else {
        this.flagValues.set(name, 'true');
      }
    }
  }

  get positionals(): readonly string[] {
    return this.positionalValues;
  }

  positional(index: number): string | undefined {
    return this.positionalValues[index];
  }

  flag(name: string): string | undefined;
  flag(name: string, fallback: string): string;
  flag(name: string, fallback?: string): string | undefined {
    return this.flagValues.get(name) ?? fallback;
  }

  number(name: string, fallback: number): number {
    const raw = this.flagValues.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  bool(name: string): boolean {
    return this.flagValues.has(name);
  }

  static fail(message: string): never {
    console.error(message);
    process.exit(1);
  }
}
