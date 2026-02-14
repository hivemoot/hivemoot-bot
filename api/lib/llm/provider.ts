/**
 * LLM Provider Factory
 *
 * Creates LLM model instances using Vercel AI SDK.
 * Supports multiple providers via environment configuration.
 *
 * Environment Variables:
 * - LLM_PROVIDER: openai | anthropic | google | gemini | mistral
 *     ("gemini" is accepted as an alias for "google")
 * - LLM_MODEL: Model name (e.g., claude-3-haiku-20240307, gpt-4o-mini)
 * - ANTHROPIC_API_KEY / OPENAI_API_KEY / etc: Provider-specific API keys
 *     (Google accepts GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY)
 * - LLM_MAX_TOKENS: Optional, defaults to 2000
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

import type { LLMConfig, LLMProvider } from "./types.js";
import { LLM_DEFAULTS } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// Environment Parsing
// ───────────────────────────────────────────────────────────────────────────────

const PROVIDER_ALIASES: Readonly<Record<string, LLMProvider>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  mistral: "mistral",
};

function normalizeEnvString(value: string | undefined, name?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const hasMatchingQuotes =
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (hasMatchingQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (normalized !== value && name) {
    console.warn(`[llm] env var ${name} was normalized (whitespace/quotes removed)`);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProvider(provider: string | undefined): LLMProvider | undefined {
  const normalized = normalizeEnvString(provider, "LLM_PROVIDER")?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return PROVIDER_ALIASES[normalized];
}

/**
 * Check if LLM is configured (provider and model set).
 */
export function isLLMConfigured(): boolean {
  return getLLMConfig() !== null;
}

/**
 * Get LLM configuration from environment variables.
 * Returns null if not configured.
 */
export function getLLMConfig(): LLMConfig | null {
  const provider = normalizeProvider(process.env.LLM_PROVIDER);
  const model = normalizeEnvString(process.env.LLM_MODEL, "LLM_MODEL");

  if (!provider || !model) {
    return null;
  }

  const maxTokens = parseInt(normalizeEnvString(process.env.LLM_MAX_TOKENS, "LLM_MAX_TOKENS") ?? "", 10);

  return {
    provider,
    model,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : LLM_DEFAULTS.maxTokens,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Provider Factory
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a language model instance for the configured provider.
 *
 * @param config - LLM configuration
 * @returns LanguageModelV1 instance
 * @throws Error if API key is missing for the provider
 */
export function createModel(config: LLMConfig): LanguageModelV1 {
  switch (config.provider) {
    case "anthropic": {
      const apiKey = normalizeEnvString(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      }
      const anthropic = createAnthropic({ apiKey });
      return anthropic(config.model);
    }

    case "openai": {
      const apiKey = normalizeEnvString(process.env.OPENAI_API_KEY, "OPENAI_API_KEY");
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }
      const openai = createOpenAI({ apiKey });
      return openai(config.model);
    }

    case "google": {
      // GOOGLE_API_KEY takes priority for backward compat with existing deployments.
      // GOOGLE_GENERATIVE_AI_API_KEY is the AI SDK default, accepted as fallback
      // so users following Vercel AI SDK docs don't need a separate var.
      const apiKey =
        normalizeEnvString(process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY") ??
        normalizeEnvString(process.env.GOOGLE_GENERATIVE_AI_API_KEY, "GOOGLE_GENERATIVE_AI_API_KEY");
      if (!apiKey) {
        throw new Error("GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set");
      }
      const google = createGoogleGenerativeAI({ apiKey });
      return google(config.model);
    }

    case "mistral": {
      const apiKey = normalizeEnvString(process.env.MISTRAL_API_KEY, "MISTRAL_API_KEY");
      if (!apiKey) {
        throw new Error("MISTRAL_API_KEY environment variable is not set");
      }
      const mistral = createMistral({ apiKey });
      return mistral(config.model);
    }

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.provider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
    }
  }
}

/**
 * Create a model from environment configuration.
 * Returns null if LLM is not configured.
 */
export function createModelFromEnv(): { model: LanguageModelV1; config: LLMConfig } | null {
  const config = getLLMConfig();
  if (!config) {
    return null;
  }

  return {
    model: createModel(config),
    config,
  };
}
