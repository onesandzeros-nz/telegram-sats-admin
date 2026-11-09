export type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

export function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (order[level] < order[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra && Object.keys(extra).length > 0) {
    out(line, JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } else {
    out(line);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
