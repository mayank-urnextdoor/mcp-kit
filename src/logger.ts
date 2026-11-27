export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every line it writes. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /**
   * Where serialized lines go. Defaults to stderr: with the stdio transport,
   * stdout carries the JSON-RPC stream and must not be polluted by logs.
   */
  sink?: (line: string) => void;
  bindings?: LogFields;
  /** Clock override, used by tests. */
  now?: () => Date;
}

/** Field names whose values are never written to logs. Matched case-insensitively. */
const REDACTED_KEYS = new Set(["authorization", "token", "secret", "password", "cookie"]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * Minimal structured JSON logger: one JSON object per line, no dependencies.
 * Swap it for pino or similar by implementing the `Logger` interface.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = redact({ ...bindings, ...fields }) as LogFields;
    let line: string;
    try {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, ...record });
    } catch {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, logError: "unserializable fields" });
    }
    sink(line);
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** A logger that drops everything. Handy in tests. */
export const silentLogger: Logger = createLogger({ sink: () => {} });
