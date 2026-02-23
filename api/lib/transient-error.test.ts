import { describe, it, expect } from "vitest";
import { isTransientError, TRANSIENT_NETWORK_CODES } from "./transient-error.js";

describe("isTransientError", () => {
  describe("network codes", () => {
    it.each([...TRANSIENT_NETWORK_CODES])("should return true for %s", (code) => {
      expect(isTransientError({ code })).toBe(true);
    });

    it("should return false for an unknown network code", () => {
      expect(isTransientError({ code: "EUNKNOWN" })).toBe(false);
    });
  });

  describe("HTTP status codes", () => {
    it("should return true for HTTP 429 (rate limit)", () => {
      expect(isTransientError({ status: 429 })).toBe(true);
    });

    it("should return true for HTTP 500 (internal server error)", () => {
      expect(isTransientError({ status: 500 })).toBe(true);
    });

    it("should return true for HTTP 502 (bad gateway)", () => {
      expect(isTransientError({ status: 502 })).toBe(true);
    });

    it("should return true for HTTP 503 (service unavailable)", () => {
      expect(isTransientError({ status: 503 })).toBe(true);
    });

    it("should return true for HTTP 504 (gateway timeout)", () => {
      expect(isTransientError({ status: 504 })).toBe(true);
    });

    it("should return false for HTTP 400 (bad request)", () => {
      expect(isTransientError({ status: 400 })).toBe(false);
    });

    it("should return false for HTTP 401 (unauthorized)", () => {
      expect(isTransientError({ status: 401 })).toBe(false);
    });

    it("should return false for HTTP 403 (forbidden)", () => {
      expect(isTransientError({ status: 403 })).toBe(false);
    });

    it("should return false for HTTP 404 (not found)", () => {
      expect(isTransientError({ status: 404 })).toBe(false);
    });

    it("should return false for HTTP 422 (unprocessable entity)", () => {
      expect(isTransientError({ status: 422 })).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should return false for a plain Error without status or code", () => {
      expect(isTransientError(new Error("Something broke"))).toBe(false);
    });

    it("should return false for null", () => {
      expect(isTransientError(null)).toBe(false);
    });

    it("should return false for a string", () => {
      expect(isTransientError("error")).toBe(false);
    });

    it("should return false for an empty object", () => {
      expect(isTransientError({})).toBe(false);
    });

    it("should return false when code is a non-string value", () => {
      expect(isTransientError({ code: 42 })).toBe(false);
    });
  });
});
