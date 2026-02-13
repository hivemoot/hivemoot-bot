/**
 * LLM Provider Factory
 *
 * Creates LLM model instances using Vercel AI SDK.
 * Supports multiple providers via environment configuration.
 *
 * Environment Variables:
 * - LLM_PROVIDER: openai | anthropic | google | mistral
 * - LLM_MODEL: Model name (e.g., claude-3-haiku-20240307, gpt-4o-mini)
 * - ANTHROPIC_API_KEY / OPENAI_API_KEY / etc: Provider-specific API keys
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

const VALID_PROVIDERS: readonly LLMProvider[] = ["openai", "anthropic", "google", "mistral"];

function parseMaxTokens(rawValue: string | undefined): number {
  const value = rawValue?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return LLM_DEFAULTS.maxTokens;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return LLM_DEFAULTS.maxTokens;
  }

  return parsed;
}

/**
 * Check if LLM is configured (provider and model set).
 */
export function isLLMConfigured(): boolean {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  return !!provider && !!model && VALID_PROVIDERS.includes(provider as LLMProvider);
}

/**
 * Get LLM configuration from environment variables.
 * Returns null if not configured.
 */
export function getLLMConfig(): LLMConfig | null {
  const provider = process.env.LLM_PROVIDER as LLMProvider | undefined;
  const model = process.env.LLM_MODEL;

  if (!provider || !model) {
    return null;
  }

  if (!VALID_PROVIDERS.includes(provider)) {
    return null;
  }

  return {
    provider,
    model,
    maxTokens: parseMaxTokens(process.env.LLM_MAX_TOKENS),
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
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      }
      const anthropic = createAnthropic({ apiKey });
      return anthropic(config.model);
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }
      const openai = createOpenAI({ apiKey });
      return openai(config.model);
    }

    case "google": {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_API_KEY environment variable is not set");
      }
      const google = createGoogleGenerativeAI({ apiKey });
      return google(config.model);
    }

    case "mistral": {
      const apiKey = process.env.MISTRAL_API_KEY;
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
