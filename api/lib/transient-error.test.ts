import { describe, it, expect } from "vitest";
import { isTransientError, TRANSIENT_NETWORK_CODES } from "./transient-error.js";

describe("TRANSIENT_NETWORK_CODES", () => {
  it("includes the full set of expected network codes", () => {
    for (const code of [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
    ]) {
      expect(TRANSIENT_NETWORK_CODES.has(code)).toBe(true);
    }
  });
});

describe("isTransientError", () => {
  describe("network-level errors", () => {
    it("returns true for ECONNRESET", () => {
      expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    });

    it("returns true for ETIMEDOUT", () => {
      expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("returns true for ECONNREFUSED", () => {
      expect(isTransientError({ code: "ECONNREFUSED" })).toBe(true);
    });

    it("returns true for ENOTFOUND", () => {
      expect(isTransientError({ code: "ENOTFOUND" })).toBe(true);
    });

    it("returns true for EAI_AGAIN", () => {
      expect(isTransientError({ code: "EAI_AGAIN" })).toBe(true);
    });

    it("returns true for EPIPE", () => {
      expect(isTransientError({ code: "EPIPE" })).toBe(true);
    });
  });

  describe("HTTP 5xx server errors", () => {
    it("returns true for 500 Internal Server Error", () => {
      expect(isTransientError({ status: 500 })).toBe(true);
    });

    it("returns true for 502 Bad Gateway", () => {
      expect(isTransientError({ status: 502 })).toBe(true);
    });

    it("returns true for 503 Service Unavailable", () => {
      expect(isTransientError({ status: 503 })).toBe(true);
    });

    it("returns true for 504 Gateway Timeout", () => {
      expect(isTransientError({ status: 504 })).toBe(true);
    });
  });

  describe("HTTP 429 rate limit", () => {
    it("returns true for 429 with no headers", () => {
      expect(isTransientError({ status: 429 })).toBe(true);
    });

    it("returns true for 429 with retry-after header", () => {
      expect(
        isTransientError({
          status: 429,
          response: { headers: { "retry-after": "60" } },
        }),
      ).toBe(true);
    });
  });

  describe("HTTP 403 rate limit indicators", () => {
    it("returns true for 403 with x-ratelimit-remaining: 0", () => {
      expect(
        isTransientError({
          status: 403,
          response: { headers: { "x-ratelimit-remaining": "0" } },
        }),
      ).toBe(true);
    });

    it("returns true for 403 with retry-after header", () => {
      expect(
        isTransientError({
          status: 403,
          response: { headers: { "retry-after": "60" } },
        }),
      ).toBe(true);
    });

    it("returns true for 403 with rate limit message", () => {
      expect(
        isTransientError({ status: 403, message: "API rate limit exceeded" }),
      ).toBe(true);
    });

    it("returns false for plain 403 without rate limit indicators", () => {
      expect(isTransientError({ status: 403 })).toBe(false);
    });
  });

  describe("non-transient errors", () => {
    it("returns false for 404 Not Found", () => {
      expect(isTransientError({ status: 404 })).toBe(false);
    });

    it("returns false for 401 Unauthorized", () => {
      expect(isTransientError({ status: 401 })).toBe(false);
    });

    it("returns false for 400 Bad Request", () => {
      expect(isTransientError({ status: 400 })).toBe(false);
    });

    it("returns false for 422 Unprocessable Entity", () => {
      expect(isTransientError({ status: 422 })).toBe(false);
    });

    it("returns false for plain Error without status or code", () => {
      expect(isTransientError(new Error("Something broke"))).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTransientError(null)).toBe(false);
    });

    it("returns false for a string", () => {
      expect(isTransientError("error")).toBe(false);
    });
  });
});
