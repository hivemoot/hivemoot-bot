/**
 * Shared transient-error detection.
 *
 * A single source of truth for "is this error worth retrying?"  Used by both
 * the webhook command path (handlers.ts) and scheduled scripts
 * (close-discussions.ts).  Prevents the two implementations from drifting
 * apart in coverage.
 */

/** Network-level error codes that indicate a transient failure. */
export const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/** Extract HTTP status from an error of unknown shape. */
function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** Extract a response header value, case-insensitively. */
function getHeaderValue(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) {
      return String(value);
    }
  }
  return undefined;
}

/**
 * Returns true when a 403/429 is caused by GitHub rate limiting rather than a
 * genuine permission denial.  Checks response headers and the error message.
 */
export function isRateLimitError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== 403 && status !== 429) return false;
  const err = error as {
    response?: { headers?: Record<string, string | number | undefined> };
    message?: string;
  };
  const remaining = getHeaderValue(
    err.response?.headers,
    "x-ratelimit-remaining",
  );
  const retryAfter = getHeaderValue(err.response?.headers, "retry-after");
  if (remaining === "0" || retryAfter) return true;
  const message = err.message?.toLowerCase() ?? "";
  return message.includes("rate limit");
}

/**
 * Returns true when the error represents a transient failure worth retrying:
 * - Network-level errors: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND,
 *   EAI_AGAIN, EPIPE
 * - HTTP 429 (rate limit) or any 5xx (server error)
 * - HTTP 403 caused by rate limiting (identified via response headers or
 *   error message)
 */
export function isTransientError(error: unknown): boolean {
  // Network-level errors
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    if (TRANSIENT_NETWORK_CODES.has((error as { code: string }).code)) {
      return true;
    }
  }

  // HTTP 429 (rate limit) or any 5xx (server error)
  const status = getErrorStatus(error);
  if (status === 429 || (status !== null && status >= 500)) {
    return true;
  }

  // HTTP 403 caused by rate limiting (not a genuine permission denial)
  if (isRateLimitError(error)) {
    return true;
  }

  return false;
}
