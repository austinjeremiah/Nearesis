/** Transient-error classification and bounded exponential backoff for ClickHouse, Postgres, Redis and network calls. */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "57P01", // admin_shutdown (Postgres backend terminated)
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);
const TRANSIENT_TEXT =
  /timeout error|timed out|socket hang up|connection terminated|connection (is )?closed|terminating connection|the database system is (starting up|shutting down|in recovery)|fetch failed|read ECONN|network error|ECONNRESET|server closed the connection|too many connections|Connection is closed|MaxRetriesPerRequest/i;

/** True for errors worth retrying: timeouts, resets and refused connections, backend restarts. Never for logic or data errors. */
export function isTransientError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    const err = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof err.code === "string" && (TRANSIENT_CODES.has(err.code) || err.code.startsWith("08")))
      return true;
    if (typeof err.message === "string" && TRANSIENT_TEXT.test(err.message)) return true;
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    cur = err.cause;
  }
  return false;
}

export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface RetryOptions {
  /** Total attempts including the first; Infinity retries until `shouldStop`. Default 5. */
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  isTransient?: (e: unknown) => boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs `fn`, retrying transient failures with backoff. Non-transient errors and exhausted attempts rethrow the last error. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 5;
  const transient = o.isTransient ?? isTransientError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!transient(error) || attempt >= attempts || o.shouldStop?.()) throw error;
      const delayMs = backoffDelayMs(attempt, o.baseMs, o.maxMs);
      o.onRetry?.({ attempt, delayMs, error });
      await (o.sleep ?? realSleep)(delayMs);
    }
  }
}
