import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SIGNATURES, parseMetadata, NOTIFICATION_TYPES, type NotificationMetadata } from "./lib/bot-comments.js";

/**
 * Tests for config.ts
 *
 * These tests verify environment variable parsing behavior,
 * particularly the handling of invalid/non-numeric values
 * and the validation bounds (1 minute to 30 days).
 */

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset module cache to allow re-importing with different env vars
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("phase duration parsing", () => {
    it("should use default duration when env var is undefined", async () => {
      delete process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES;
      delete process.env.HIVEMOOT_VOTING_DURATION_MINUTES;

      const config = await import("./config.js");

      // Default is 24 hours = 24 * 60 minutes = 1440 minutes = 86,400,000 ms
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
      expect(config.VOTING_DURATION_MS).toBe(expectedMs);
    });

    it("should parse valid numeric env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "30";
      process.env.HIVEMOOT_VOTING_DURATION_MINUTES = "60";

      const config = await import("./config.js");

      expect(config.DISCUSSION_DURATION_MS).toBe(30 * 60 * 1000);
      expect(config.VOTING_DURATION_MS).toBe(60 * 60 * 1000);
    });

    it("should fall back to default for invalid non-numeric env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "invalid";
      process.env.HIVEMOOT_VOTING_DURATION_MINUTES = "abc123";

      const config = await import("./config.js");

      // Should use default (24 hours) instead of NaN
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
      expect(config.VOTING_DURATION_MS).toBe(expectedMs);
    });

    it("should fall back to default for empty string env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "";

      const config = await import("./config.js");

      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
    });

    it("should clamp zero to minimum (1 minute)", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "0";

      const config = await import("./config.js");

      // Zero should be clamped to minimum of 1 minute
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);
    });

    it("should clamp negative values to minimum (1 minute)", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "-100";

      const config = await import("./config.js");

      // Negative should be clamped to minimum of 1 minute
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);
    });

    it("should clamp extremely large values to maximum (30 days)", async () => {
      // 999999999 minutes is way more than 30 days
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "999999999";

      const config = await import("./config.js");

      // Should be clamped to 30 days max
      const maxMinutes = 30 * 24 * 60; // 43200 minutes
      expect(config.DISCUSSION_DURATION_MS).toBe(maxMinutes * 60 * 1000);
    });

    it("should allow values at the boundaries", async () => {
      // Minimum: 1 minute
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "1";

      let config = await import("./config.js");
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);

      // Reset and test maximum: 30 days = 43200 minutes
      vi.resetModules();
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "43200";

      config = await import("./config.js");
      expect(config.DISCUSSION_DURATION_MS).toBe(43200 * 60 * 1000);
    });
  });

  describe("voting comment signature", () => {
    it("should include SIGNATURES.VOTING in VOTING_START message", async () => {
      const config = await import("./config.js");

      expect(config.MESSAGES.VOTING_START).toContain(SIGNATURES.VOTING);
    });

    it("should list all four voting reactions in VOTING_START message", async () => {
      const config = await import("./config.js");

      expect(config.MESSAGES.VOTING_START).toContain("👍");
      expect(config.MESSAGES.VOTING_START).toContain("👎");
      expect(config.MESSAGES.VOTING_START).toContain("😕");
      expect(config.MESSAGES.VOTING_START).toContain("👀");
    });
  });

  describe("labels", () => {
    it("should export READY_TO_IMPLEMENT label (not ACCEPTED)", async () => {
      const config = await import("./config.js");

      expect(config.LABELS.READY_TO_IMPLEMENT).toBe("phase:ready-to-implement");
      expect((config.LABELS as Record<string, string>).ACCEPTED).toBeUndefined();
    });

    it("should define metadata for all required repository labels", async () => {
      const config = await import("./config.js");

      const labelNames = new Set(config.REQUIRED_REPOSITORY_LABELS.map((label) => label.name));
      expect(labelNames).toEqual(new Set(Object.values(config.LABELS)));

      for (const label of config.REQUIRED_REPOSITORY_LABELS) {
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
        expect(label.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("PR_MESSAGES", () => {
    it("should format issueNotReadyToImplement correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueNotReadyToImplement(42);
      expect(message).toContain("Issue #42");
      expect(message).toContain("hasn't passed voting");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format issueReadyNeedsUpdate correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueReadyNeedsUpdate(42);
      expect(message).toContain("Issue #42");
      expect(message).toContain("opened before approval");
      expect(message).toContain("commit");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prNoRoomYet correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prNoRoomYet(2, [10, 11]);
      expect(message).toContain("2 active implementation PRs");
      expect(message).toContain("#10");
      expect(message).toContain("#11");
      expect(message).toContain("slot opens");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prSuperseded correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prSuperseded(123);
      expect(message).toContain("#123");
      expect(message).toContain("Implemented");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format approvalReminder correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.approvalReminder([1, 2, 3]);
      expect(message).toContain("3 competing implementations");
      expect(message).toContain("#1");
      expect(message).toContain("#2");
      expect(message).toContain("#3");
      expect(message).toContain("Review and approve");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prStaleWarning correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prStaleWarning(14, 7);
      expect(message).toContain("14 days");
      expect(message).toContain("7 days");
      expect(message).toContain("Stale Warning");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prStaleClosed correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prStaleClosed(21);
      expect(message).toContain("21 days");
      expect(message).toContain("Auto-Closed");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should embed notification metadata in IMPLEMENTATION_WELCOME", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42);

      expect(message).toContain("hivemoot-metadata:");

      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME);
      expect(metadata?.issueNumber).toBe(42);

      expect(message).toContain("Implementation PR");
      expect(message).toContain("#42");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should embed notification metadata in issueNewPR", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueNewPR(101, 3);

      expect(message).toContain("hivemoot-metadata:");

      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.ISSUE_NEW_PR);
      // issueNewPR uses prNumber as the reference number for dedup keying
      expect(metadata?.issueNumber).toBe(101);

      expect(message).toContain("#101");
      expect(message).toContain("3 competing implementations");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should embed notification metadata in issueVotingPassed", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueVotingPassed(42, "agent-alice");

      // Should contain metadata tag
      expect(message).toContain("hivemoot-metadata:");

      // Should parse to notification type with correct fields
      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.VOTING_PASSED);
      expect(metadata?.issueNumber).toBe(42);

      // Content should still be present
      expect(message).toContain("passed voting");
      expect(message).toContain("@agent-alice");
      expect(message).toContain(config.SIGNATURE);
    });
  });
});
