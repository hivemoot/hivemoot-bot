/**
 * Transient Error Detection
 *
 * Shared utilities for classifying errors as transient (network-level or
 * server-side) and therefore worth retrying rather than treating as
 * permanent failures.
 *
 * Previously, equivalent logic existed independently in:
 *   - api/lib/commands/handlers.ts  (isTransientError)
 *   - scripts/close-discussions.ts  (isRetryableError)
 *
 * The two implementations had diverged: handlers.ts covered more network
 * codes and all 5xx errors; scripts covered only 502/503/504 and fewer
 * network codes. This module provides the superset.
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

function getHeaderValue(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) {
      return String(value);
    }
  }
  return undefined;
}

type HttpError = {
  status?: number;
  code?: string;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
};

/**
 * Extract the HTTP status code from an error object, or null if absent.
 */
export function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Returns true for 403 or 429 errors that carry rate-limit signals.
 * A plain 403 (permission denied without rate-limit headers) returns false.
 * A plain 429 without headers also returns false; use isTransientError for
 * the full 429 check.
 */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const err = error as HttpError;
  if (err.status !== 403 && err.status !== 429) {
    return false;
  }
  const remaining = getHeaderValue(
    err.response?.headers,
    "x-ratelimit-remaining",
  );
  const retryAfter = getHeaderValue(err.response?.headers, "retry-after");
  if (remaining === "0" || retryAfter) {
    return true;
  }
  const message = err.message?.toLowerCase() ?? "";
  return message.includes("rate limit");
}

/**
 * Determine whether an error is transient (network-level or server-side)
 * and therefore worth retrying rather than treating as a permanent failure.
 *
 * Covers:
 * - Network errors: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EPIPE
 * - Rate limits: 429 or 403 with rate-limit response signals
 * - Server errors: any HTTP 5xx
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

  const status = getErrorStatus(error);

  // HTTP 429 Too Many Requests is always transient
  if (status === 429) {
    return true;
  }

  // HTTP 5xx (server error) — covers 500, 501, 502, 503, 504, etc.
  if (status !== null && status >= 500) {
    return true;
  }

  // 403 with rate-limit signals (GitHub secondary rate limit)
  if (isRateLimitError(error)) {
    return true;
  }

  return false;
}
