/**
 * Minimal structured logger with secret redaction.
 *
 * Every log line passes through `redact`. The threat here is mundane and real:
 * an ephemeral token or bearer key ends up in a log file that later gets pasted
 * into an issue. Redaction is centralised so no call site has to remember.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

/** Keys whose values are never safe to print, matched case-insensitively. */
const SENSITIVE_KEY = /(password|passphrase|secret|token|api[_-]?key|authorization|cookie|credential)/i;

/**
 * Value shapes that look like credentials even under an innocent key name —
 * xAI keys, bearer headers, and long random-looking strings.
 */
const SENSITIVE_VALUE = /\b(xai-[A-Za-z0-9._-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';

  if (typeof value === 'string') {
    return value.replace(SENSITIVE_VALUE, '[redacted]');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return output;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = LEVELS[level];

  const emit = (entry: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVELS[entry] < threshold) return;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entry,
      msg: redact(message),
    };
    if (context && Object.keys(context).length > 0) {
      payload.ctx = redact(context);
    }
    sink(JSON.stringify(payload));
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
