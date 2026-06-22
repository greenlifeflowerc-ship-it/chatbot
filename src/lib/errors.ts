// Typed application errors. Each carries an HTTP status and a stable `code` so
// routes can translate them into clean responses and logs can be filtered.

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: { statusCode?: number; code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? 'internal_error';
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 500, code: 'config_error', cause });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 400, code: 'validation_error', cause });
  }
}

export class SignatureError extends AppError {
  constructor(message = 'Invalid webhook signature') {
    super(message, { statusCode: 403, code: 'invalid_signature' });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { statusCode: 401, code: 'unauthorized' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { statusCode: 404, code: 'not_found' });
  }
}

// External dependency failed (Graph API, LLM, embeddings, DB). Marked retryable
// so the backoff helper knows it is worth another attempt.
export class UpstreamError extends AppError {
  constructor(message: string, opts: { statusCode?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, {
      statusCode: opts.statusCode ?? 502,
      code: 'upstream_error',
      retryable: opts.retryable ?? true,
      cause: opts.cause,
    });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
