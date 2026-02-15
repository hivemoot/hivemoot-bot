/**
 * JSON repair helpers for structured LLM output.
 *
 * Several providers (notably Gemini variants) occasionally wrap otherwise
 * valid JSON in markdown fences or prepend non-JSON text (reasoning/preamble),
 * which causes AI SDK object parsing to fail.
 *
 * References:
 * - https://github.com/vercel/ai/issues/5594
 * - https://github.com/vercel/ai/issues/6183
 * - https://github.com/vercel/ai/issues/11450
 * - https://github.com/vercel/ai/issues/4906
 */

import type { RepairTextFunction } from "ai";

const FENCED_JSON_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/i;

/**
 * Attempt to extract a JSON payload from malformed model text.
 * Returns null when no safe repair candidate is found.
 */
export function extractLikelyJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Common failure: fenced JSON with optional leading noise/preamble.
  const fencedMatch = trimmed.match(FENCED_JSON_REGEX);
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim();
    return candidate.length > 0 ? candidate : null;
  }

  // Fallback: drop leading prose and keep content from first JSON token.
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const firstJsonStart =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);

  if (firstJsonStart > 0) {
    const candidate = trimmed.slice(firstJsonStart).trim();
    return candidate.length > 0 ? candidate : null;
  }

  return null;
}

/**
 * AI SDK hook for repairing malformed JSON before schema parsing.
 */
export const repairMalformedJsonText: RepairTextFunction = async ({ text }) => {
  const repaired = extractLikelyJsonPayload(text);
  if (!repaired || repaired === text) {
    return null;
  }
  return repaired;
};

