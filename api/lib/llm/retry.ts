/**
 * Rate-Limit-Aware Retry for LLM Calls
 *
 * The Vercel AI SDK's built-in retry (~2s/4s backoff) is too fast for
 * Gemini's rate-limit window (~17s). This module disables SDK retry and
 * implements our own that respects server-suggested delays.
 *
 * Strategy:
 * - On 429 (rate limit): wait the server-suggested delay, then retry
 * - On any other error: fail immediately (no retry)
 */

import { APICallError } from "@ai-sdk/provider";

import type { Logger } from "../logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types & Defaults
// ───────────────────────────────────────────────────────────────────────────────

export interface LLMRetryConfig {
  /** Maximum number of retries on rate-limit errors */
  maxRetries: number;
  /** Cap on any single retry delay (ms) */
  maxRetryDelayMs: number;
  /** Fallback delay when server doesn't suggest one (ms) */
  defaultRetryDelayMs: number;
}

export const LLM_RETRY_DEFAULTS: LLMRetryConfig = {
  maxRetries: 3,
  maxRetryDelayMs: 60_000,
  defaultRetryDelayMs: 5_000,
};

// ───────────────────────────────────────────────────────────────────────────────
// Error Detection
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether an error is an LLM rate-limit (HTTP 429).
 *
 * Uses APICallError.isInstance() rather than instanceof to handle
 * multiple package versions safely.
 */
export function isLLMRateLimitError(error: unknown): boolean {
  return APICallError.isInstance(error) && error.statusCode === 429;
}

// ───────────────────────────────────────────────────────────────────────────────
// Delay Extraction
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extract the server-suggested retry delay from a rate-limit error.
 *
 * Checks two sources:
 * 1. `retry-after` response header (OpenAI/Anthropic standard) — value in seconds
 * 2. Error message regex for "retry in X.XXXs" (Gemini style)
 *
 * Returns delay in milliseconds, or null if not parseable.
 */
export function extractRetryDelay(error: unknown): number | null {
  if (!APICallError.isInstance(error)) return null;

  // Source 1: Standard retry-after header (value in seconds or HTTP-date)
  const retryAfterHeader = getRetryAfterHeader(error.responseHeaders);
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }

    const retryAtMs = Date.parse(retryAfterHeader);
    if (!isNaN(retryAtMs)) {
      const delayMs = retryAtMs - Date.now();
      if (delayMs > 0) {
        return delayMs;
      }
    }
  }

  // Source 2: Gemini-style message — "retry in 16.566730247s"
  const match = error.message.match(/retry\s+in\s+([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

function getRetryAfterHeader(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "retry-after") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Retry Wrapper
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Execute an async function with rate-limit-aware retry.
 *
 * - On rate-limit (429): waits the server-suggested delay (capped), then retries
 * - On any other error: throws immediately — no retry
 * - Logs each retry with delay info via the optional logger
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<LLMRetryConfig>,
  logger?: Logger
): Promise<T> {
  const { maxRetries, maxRetryDelayMs, defaultRetryDelayMs } = {
    ...LLM_RETRY_DEFAULTS,
    ...config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Only retry on rate-limit errors
      if (!isLLMRateLimitError(error)) {
        throw error;
      }

      // Exhausted retries
      if (attempt >= maxRetries) {
        break;
      }

      const suggestedDelay = extractRetryDelay(error);
      const delay = Math.min(suggestedDelay ?? defaultRetryDelayMs, maxRetryDelayMs);

      logger?.info(
        `Rate-limited (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${(delay / 1000).toFixed(1)}s` +
          (suggestedDelay ? " (server-suggested)" : " (default)")
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
