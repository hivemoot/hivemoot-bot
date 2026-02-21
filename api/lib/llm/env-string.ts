/**
 * Shared env-string normalization for the api/lib/llm/ directory.
 *
 * Strips surrounding whitespace and matching quote characters from env var
 * values that may arrive with shell artifacts (e.g. from `.env` files or
 * secret-management systems that wrap values in quotes).
 */

/**
 * Normalize a raw environment variable string.
 *
 * - Trims leading/trailing whitespace.
 * - Strips a single layer of matching surrounding quotes (" or ').
 * - Returns `undefined` for empty or whitespace-only inputs.
 * - If `name` is provided, emits a `console.warn` when normalization altered
 *   the raw value (useful for diagnosing misconfigured env vars).
 */
export function normalizeEnvString(
  value: string | undefined,
  name?: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const hasMatchingQuotes =
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (hasMatchingQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (normalized !== value && name) {
    console.warn(`[llm] env var ${name} was normalized (whitespace/quotes removed)`);
  }

  return normalized.length > 0 ? normalized : undefined;
}
