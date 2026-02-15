import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isLLMConfigured, getLLMConfig, createModel, createModelFromEnv, getLLMReadiness } from "./provider.js";
import type { LLMConfig } from "./types.js";

/**
 * Tests for LLM Provider Factory
 */

describe("LLM Provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isLLMConfigured", () => {
    it("should return false when neither provider nor model is set", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false when only provider is set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      delete process.env.LLM_MODEL;

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false when only model is set", () => {
      delete process.env.LLM_PROVIDER;
      process.env.LLM_MODEL = "claude-3-haiku";

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false for invalid provider", () => {
      process.env.LLM_PROVIDER = "invalid-provider";
      process.env.LLM_MODEL = "some-model";

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return true when valid provider and model are set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";

      expect(isLLMConfigured()).toBe(true);
    });

    it("should normalize provider casing and whitespace", () => {
      process.env.LLM_PROVIDER = "  Google ";
      process.env.LLM_MODEL = " gemini-2.0-flash ";

      expect(isLLMConfigured()).toBe(true);
    });

    it("should accept gemini alias as google provider", () => {
      process.env.LLM_PROVIDER = "gemini";
      process.env.LLM_MODEL = "gemini-2.0-flash";

      expect(isLLMConfigured()).toBe(true);
    });

    it.each(["openai", "anthropic", "google", "mistral"])(
      "should return true for valid provider: %s",
      (provider) => {
        process.env.LLM_PROVIDER = provider;
        process.env.LLM_MODEL = "some-model";

        expect(isLLMConfigured()).toBe(true);
      }
    );
  });

  describe("getLLMConfig", () => {
    it("should return null when not configured", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(getLLMConfig()).toBe(null);
    });

    it("should return null for invalid provider", () => {
      process.env.LLM_PROVIDER = "not-a-provider";
      process.env.LLM_MODEL = "model";

      expect(getLLMConfig()).toBe(null);
    });

    it("should return config with defaults when optional vars not set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      delete process.env.LLM_MAX_TOKENS;

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 4_096,
      });
    });

    it("should normalize quoted provider/model values", () => {
      process.env.LLM_PROVIDER = ' "OpenAI" ';
      process.env.LLM_MODEL = " 'gpt-4o-mini' ";

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 4_096,
      });
    });

    it("should return null when model is blank after trimming", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "   ";

      expect(getLLMConfig()).toBeNull();
    });

    it("should parse custom maxTokens", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_MODEL = "gpt-4o-mini";
      process.env.LLM_MAX_TOKENS = "4000";

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 4000,
      });
    });

    it("should use defaults for invalid maxTokens", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "not-a-number";

      const config = getLLMConfig();

      expect(config?.maxTokens).toBe(4_096);
    });

    it("should use defaults for non-positive maxTokens", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "0";

      const zeroConfig = getLLMConfig();
      expect(zeroConfig?.maxTokens).toBe(4_096);

      process.env.LLM_MAX_TOKENS = "-100";
      const negativeConfig = getLLMConfig();
      expect(negativeConfig?.maxTokens).toBe(4_096);
    });

  });

  describe("createModel", () => {
    it("should throw when Anthropic API key is missing", () => {
      delete process.env.ANTHROPIC_API_KEY;
      const config: LLMConfig = {
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "ANTHROPIC_API_KEY environment variable is not set"
      );
    });

    it("should throw when OpenAI API key is missing", () => {
      delete process.env.OPENAI_API_KEY;
      const config: LLMConfig = {
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "OPENAI_API_KEY environment variable is not set"
      );
    });

    it("should throw when Google API key is missing", () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set"
      );
    });

    it("should throw when Mistral API key is missing", () => {
      delete process.env.MISTRAL_API_KEY;
      const config: LLMConfig = {
        provider: "mistral",
        model: "mistral-small",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "MISTRAL_API_KEY environment variable is not set"
      );
    });

    it("should create Anthropic model when API key is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
      const config: LLMConfig = {
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("claude-3-haiku");
    });

    it("should create OpenAI model when API key is set", () => {
      process.env.OPENAI_API_KEY = "sk-test-key";
      const config: LLMConfig = {
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gpt-4o-mini");
    });

    it("should create Google model when API key is set", () => {
      process.env.GOOGLE_API_KEY = "google-test-key";
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gemini-pro");
    });

    it("should disable native structured outputs for Google models", () => {
      process.env.GOOGLE_API_KEY = "google-test-key";
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model.supportsStructuredOutputs).toBe(false);
    });

    it("should create Google model from GOOGLE_GENERATIVE_AI_API_KEY", () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-alt-test-key";
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gemini-pro");
    });

    it("should create Mistral model when API key is set", () => {
      process.env.MISTRAL_API_KEY = "mistral-test-key";
      const config: LLMConfig = {
        provider: "mistral",
        model: "mistral-small",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("mistral-small");
    });
  });

  describe("getLLMReadiness", () => {
    it("should return not_configured when provider is missing", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "not_configured" });
    });

    it("should return not_configured for invalid provider", () => {
      process.env.LLM_PROVIDER = "invalid";
      process.env.LLM_MODEL = "some-model";

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "not_configured" });
    });

    it("should return api_key_missing when provider+model set but key absent", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      delete process.env.ANTHROPIC_API_KEY;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return api_key_missing for google when both key vars are absent", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "gemini-pro";
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return ready when provider, model, and key are present", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      expect(getLLMReadiness()).toEqual({ ready: true });
    });

    it("should return ready for google with GOOGLE_GENERATIVE_AI_API_KEY fallback", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "gemini-pro";
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-alt-key";

      expect(getLLMReadiness()).toEqual({ ready: true });
    });

    it("should treat whitespace-only API key as missing", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_MODEL = "gpt-4o-mini";
      process.env.OPENAI_API_KEY = "   ";

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });
  });

  describe("createModelFromEnv", () => {
    it("should return null when LLM not configured", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(createModelFromEnv()).toBeNull();
    });

    it("should return model and config when configured", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      const result = createModelFromEnv();

      expect(result).not.toBeNull();
      expect(result?.model).toBeDefined();
      expect(result?.model.modelId).toBe("claude-3-haiku");
      expect(result?.config.provider).toBe("anthropic");
      expect(result?.config.model).toBe("claude-3-haiku");
    });

    it("should return model and normalized config for gemini alias", () => {
      process.env.LLM_PROVIDER = "Gemini";
      process.env.LLM_MODEL = "gemini-2.0-flash";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";

      const result = createModelFromEnv();

      expect(result).not.toBeNull();
      expect(result?.config.provider).toBe("google");
      expect(result?.config.model).toBe("gemini-2.0-flash");
    });
  });
});
