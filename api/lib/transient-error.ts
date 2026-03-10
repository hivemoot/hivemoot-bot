/**
 * Shared transient-error classifier
 *
 * A single source of truth for determining whether a GitHub API or network
 * error is transient and worth retrying, rather than a permanent auth denial
 * or validation failure.
 */

import { getErrorStatus } from "./github-client.js";

/**
 * Network-level error codes that indicate a transient failure.
 * Used by both webhook handlers and scheduled scripts.
 */
export const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * Determine whether an error is transient — a network-level or server-side
 * failure worth retrying rather than a permanent auth/validation denial.
 *
 * Returns true for:
 * - Known transient network codes (ECONNRESET, ETIMEDOUT, ECONNREFUSED, etc.)
 * - HTTP 429 (rate limit) or any 5xx (server error)
 */
export function isTransientError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
  }
  const status = getErrorStatus(error);
  return status !== null && (status === 429 || status >= 500);
}
