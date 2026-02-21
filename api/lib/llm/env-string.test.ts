import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeEnvString } from "./env-string.js";

describe("normalizeEnvString", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("undefined input", () => {
    it("returns undefined for undefined", () => {
      expect(normalizeEnvString(undefined)).toBeUndefined();
    });

    it("returns undefined for undefined with a name", () => {
      expect(normalizeEnvString(undefined, "MY_VAR")).toBeUndefined();
    });
  });

  describe("empty / whitespace-only input", () => {
    it("returns undefined for empty string", () => {
      expect(normalizeEnvString("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(normalizeEnvString("   ")).toBeUndefined();
    });

    it("returns undefined for tab-only string", () => {
      expect(normalizeEnvString("\t")).toBeUndefined();
    });
  });

  describe("plain values", () => {
    it("returns the value unchanged when no normalization is needed", () => {
      expect(normalizeEnvString("anthropic")).toBe("anthropic");
    });

    it("trims leading whitespace", () => {
      expect(normalizeEnvString("  openai")).toBe("openai");
    });

    it("trims trailing whitespace", () => {
      expect(normalizeEnvString("openai  ")).toBe("openai");
    });

    it("trims both sides", () => {
      expect(normalizeEnvString("  openai  ")).toBe("openai");
    });
  });

  describe("surrounding quote stripping", () => {
    it("strips matching double quotes", () => {
      expect(normalizeEnvString('"anthropic"')).toBe("anthropic");
    });

    it("strips matching single quotes", () => {
      expect(normalizeEnvString("'anthropic'")).toBe("anthropic");
    });

    it("strips double quotes with surrounding whitespace", () => {
      expect(normalizeEnvString(' "anthropic" ')).toBe("anthropic");
    });

    it("strips single quotes with surrounding whitespace", () => {
      expect(normalizeEnvString(" 'openai' ")).toBe("openai");
    });

    it("does not strip mismatched quotes", () => {
      expect(normalizeEnvString('"anthropic\'')).toBe('"anthropic\'');
    });

    it("does not strip a single leading quote", () => {
      expect(normalizeEnvString('"anthropic')).toBe('"anthropic');
    });

    it("does not strip a single trailing quote", () => {
      expect(normalizeEnvString("anthropic\"")).toBe('anthropic"');
    });

    it("returns undefined when value is empty after quote stripping", () => {
      expect(normalizeEnvString('""')).toBeUndefined();
    });

    it("returns undefined when value is whitespace-only after quote stripping", () => {
      expect(normalizeEnvString('"  "')).toBeUndefined();
    });

    it("does not double-strip nested quotes", () => {
      expect(normalizeEnvString('"\'anthropic\'"')).toBe("'anthropic'");
    });
  });

  describe("warn logging with name", () => {
    it("logs a warning when whitespace is trimmed", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      normalizeEnvString("  openai  ", "LLM_PROVIDER");
      expect(warn).toHaveBeenCalledWith(
        "[llm] env var LLM_PROVIDER was normalized (whitespace/quotes removed)",
      );
    });

    it("logs a warning when quotes are stripped", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      normalizeEnvString('"anthropic"', "LLM_PROVIDER");
      expect(warn).toHaveBeenCalledWith(
        "[llm] env var LLM_PROVIDER was normalized (whitespace/quotes removed)",
      );
    });

    it("does not log when value is unchanged", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      normalizeEnvString("anthropic", "LLM_PROVIDER");
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not log when name is omitted even if value changed", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      normalizeEnvString("  openai  ");
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
