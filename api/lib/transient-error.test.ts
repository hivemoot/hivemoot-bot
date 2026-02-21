import { describe, it, expect } from "vitest";
import {
  TRANSIENT_NETWORK_CODES,
  getErrorStatus,
  isRateLimitError,
  isTransientError,
} from "./transient-error.js";

describe("TRANSIENT_NETWORK_CODES", () => {
  it("includes the full set of expected network codes", () => {
    const expected = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
    ];
    for (const code of expected) {
      expect(TRANSIENT_NETWORK_CODES.has(code)).toBe(true);
    }
  });
});

describe("getErrorStatus", () => {
  it("returns the numeric status from an error object", () => {
    expect(getErrorStatus({ status: 404 })).toBe(404);
    expect(getErrorStatus({ status: 500 })).toBe(500);
  });

  it("returns null when status is absent", () => {
    expect(getErrorStatus({})).toBe(null);
    expect(getErrorStatus(new Error("oops"))).toBe(null);
    expect(getErrorStatus(null)).toBe(null);
    expect(getErrorStatus("string")).toBe(null);
  });

  it("returns null when status is not a number", () => {
    expect(getErrorStatus({ status: "200" })).toBe(null);
    expect(getErrorStatus({ status: null })).toBe(null);
  });
});

describe("isRateLimitError", () => {
  it("returns true for 429 with retry-after header", () => {
    expect(
      isRateLimitError({
        status: 429,
        response: { headers: { "retry-after": "60" } },
      }),
    ).toBe(true);
  });

  it("returns true for 403 with x-ratelimit-remaining: 0", () => {
    expect(
      isRateLimitError({
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe(true);
  });

  it("returns true for 403 with rate limit message", () => {
    expect(
      isRateLimitError({
        status: 403,
        message: "API rate limit exceeded",
      }),
    ).toBe(true);
  });

  it("returns true for 429 with rate limit message (no headers)", () => {
    expect(
      isRateLimitError({
        status: 429,
        message: "rate limit exceeded",
      }),
    ).toBe(true);
  });

  it("returns false for 403 without rate limit indicators", () => {
    expect(isRateLimitError({ status: 403 })).toBe(false);
  });

  it("returns false for 403 with x-ratelimit-remaining > 0", () => {
    expect(
      isRateLimitError({
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "10" } },
      }),
    ).toBe(false);
  });

  it("returns false for non-rate-limit statuses", () => {
    expect(isRateLimitError({ status: 404 })).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError({ status: 401 })).toBe(false);
  });

  it("returns false for plain errors without status", () => {
    expect(isRateLimitError(new Error("Something broke"))).toBe(false);
    expect(isRateLimitError({})).toBe(false);
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

    it("returns false for unrecognised network codes", () => {
      expect(isTransientError({ code: "ENOENT" })).toBe(false);
    });
  });

  describe("rate-limited errors", () => {
    it("returns true for 429", () => {
      expect(isTransientError({ status: 429 })).toBe(true);
    });

    it("returns true for 403 with rate limit header", () => {
      expect(
        isTransientError({
          status: 403,
          response: { headers: { "x-ratelimit-remaining": "0" } },
        }),
      ).toBe(true);
    });

    it("returns false for 403 without rate limit indicators", () => {
      expect(isTransientError({ status: 403 })).toBe(false);
    });
  });

  describe("HTTP 5xx server errors", () => {
    it("returns true for 500", () => {
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

    it("returns true for any 5xx", () => {
      expect(isTransientError({ status: 501 })).toBe(true);
      expect(isTransientError({ status: 505 })).toBe(true);
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
      expect(isTransientError("error string")).toBe(false);
    });
  });
});
