import { AppError } from './errors';
import { logger } from './logger';

export interface RetryOptions {
  retries?: number; // number of retries after the first attempt
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Decide whether a thrown error is worth retrying. Defaults to AppError.retryable
  // (true for unknown/non-AppError, since transient infra failures often surface
  // as generic errors).
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  label?: string;
}

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  if (err instanceof AppError) return err.retryable;
  return true;
};

// Deterministic-ish jittered exponential backoff with a ceiling. We avoid
// Math.random for full jitter and instead use a bounded pseudo-jitter derived
// from the attempt, which is sufficient to desynchronise retries without a RNG
// dependency.
function backoffDelay(attempt: number, base: number, max: number): number {
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = exp * 0.25 * ((attempt % 3) / 2); // 0, 0.125x, 0.25x
  return Math.min(max, Math.round(exp - exp * 0.125 + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run `fn`, retrying transient failures with exponential backoff. Re-throws the
// last error once retries are exhausted or the error is deemed non-retryable.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 4;
  const base = options.baseDelayMs ?? 300;
  const max = options.maxDelayMs ?? 8_000;
  const isRetryable = options.isRetryable ?? DEFAULT_RETRYABLE;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !isRetryable(err)) break;
      const delay = backoffDelay(attempt, base, max);
      options.onRetry?.(err, attempt + 1, delay);
      logger.warn(
        { attempt: attempt + 1, retries, delay, label: options.label, err },
        'retrying after failure',
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
