export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly context: Readonly<Record<string, JsonValue>>;
}

export interface DiagnosticReport {
  readonly generatedAt: number;
  readonly logs: readonly LogEntry[];
}

const sensitiveKey =
  /authorization|password|passwd|secret|token|credential|icepwd|email|phone|customer|raw|sdp/i;
const authorizationValue = /\b(?:proxy-)?authorization\s*:\s*[^\r\n]+/gi;
const sdpSecretValue = /^(?:a=ice-pwd:|a=crypto:).+$/gim;

function sanitizeString(value: string): string {
  return value
    .replace(authorizationValue, 'Authorization: [REDACTED]')
    .replace(sdpSecretValue, '[REDACTED]');
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  seen.add(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? '[REDACTED]' : sanitizeValue(child, seen);
  }
  seen.delete(value);
  return output;
}

export function redactContext(context: LogContext = {}): Readonly<Record<string, JsonValue>> {
  return Object.freeze(sanitizeValue(context, new WeakSet<object>()) as Record<string, JsonValue>);
}

export class RingBuffer<T> {
  readonly #capacity: number;
  readonly #values: T[] = [];

  public constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('RingBuffer capacity must be a positive integer.');
    }
    this.#capacity = capacity;
  }

  public push(value: T): void {
    if (this.#values.length === this.#capacity) {
      this.#values.shift();
    }
    this.#values.push(value);
  }

  public values(): readonly T[] {
    return Object.freeze([...this.#values]);
  }
}

export interface StructuredLoggerOptions {
  readonly scope: string;
  readonly minimumLevel?: LogLevel;
  readonly capacity?: number;
  readonly now?: () => number;
  readonly sink?: (entry: LogEntry) => void;
}

const levelWeight: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger {
  readonly #scope: string;
  readonly #minimumLevel: LogLevel;
  readonly #buffer: RingBuffer<LogEntry>;
  readonly #now: () => number;
  readonly #sink?: (entry: LogEntry) => void;

  public constructor(options: StructuredLoggerOptions) {
    this.#scope = options.scope;
    this.#minimumLevel = options.minimumLevel ?? 'info';
    this.#buffer = new RingBuffer(options.capacity ?? 200);
    this.#now = options.now ?? Date.now;
    if (options.sink !== undefined) {
      this.#sink = options.sink;
    }
  }

  public log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (levelWeight[level] < levelWeight[this.#minimumLevel]) {
      return;
    }

    const entry: LogEntry = Object.freeze({
      timestamp: this.#now(),
      level,
      scope: this.#scope,
      message: `[MiCall:${this.#scope}] ${sanitizeString(message)}`,
      context: redactContext(context),
    });
    this.#buffer.push(entry);
    this.#sink?.(entry);
  }

  public getRecentLogs(): readonly LogEntry[] {
    return this.#buffer.values();
  }

  public exportDiagnostics(): DiagnosticReport {
    return Object.freeze({ generatedAt: this.#now(), logs: this.getRecentLogs() });
  }
}
