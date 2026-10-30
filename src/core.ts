/** A page of a list endpoint. Pass `next_cursor` as `cursor` to get the next one, or use the `…Iter` methods. */
export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface RequestOptions {
  /** Sent as `Idempotency-Key` on POSTs. Generated automatically when omitted, and reused across retries. */
  idempotencyKey?: string;
  /** Overrides the client's `maxRetries` for this request. */
  maxRetries?: number;
  /** Overrides the client's `timeoutMs` for this request. */
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Any non-2xx response. Subclasses narrow on status; `code` is the API's machine-readable error code. */
export class PitchMentorError extends Error {
  override name = "PitchMentorError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly headers: Headers,
    readonly body: unknown
  ) {
    super(message);
  }
}

export class BadRequestError extends PitchMentorError {
  override name = "BadRequestError";
}
export class AuthenticationError extends PitchMentorError {
  override name = "AuthenticationError";
}
export class PermissionDeniedError extends PitchMentorError {
  override name = "PermissionDeniedError";
}
export class NotFoundError extends PitchMentorError {
  override name = "NotFoundError";
}
export class ConflictError extends PitchMentorError {
  override name = "ConflictError";
}
export class UnprocessableEntityError extends PitchMentorError {
  override name = "UnprocessableEntityError";
}
export class RateLimitError extends PitchMentorError {
  override name = "RateLimitError";
  /** Seconds to wait before retrying, from the `retry-after` header. */
  get retryAfter(): number | null {
    return parseRetryAfter(this.headers.get("retry-after"));
  }
}
export class InternalServerError extends PitchMentorError {
  override name = "InternalServerError";
}

/** The request never got an HTTP response (network failure or timeout). */
export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const ERROR_CLASSES: Record<number, typeof PitchMentorError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

export function errorFromResponse(status: number, headers: Headers, body: unknown): PitchMentorError {
  // v1 shape is {error:{code,message}}; tolerate plain-text and {error: "message"} bodies too
  const err = (body as { error?: unknown } | null)?.error;
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : status >= 500 ? "internal_error" : "error";
  const message =
    typeof err === "object" && err && "message" in err
      ? String(err.message)
      : typeof err === "string"
        ? err
        : typeof body === "string" && body
          ? body.slice(0, 500)
          : `HTTP ${status}`;
  const Cls = ERROR_CLASSES[status] ?? (status >= 500 ? InternalServerError : PitchMentorError);
  return new Cls(message, status, code, headers, body);
}

/** Seconds from a `retry-after` header (delta-seconds or HTTP date). */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}
