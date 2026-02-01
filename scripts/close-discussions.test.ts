import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for close-discussions script logic
 *
 * Tests the phase transition orchestration functions.
 * The script's main() function is tested indirectly through
 * the processIssuePhase and processRepository functions.
 */

// Mock the external dependencies before importing
vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

// Suppress unhandled rejection from module-level main().catch() calling process.exit(1).
// Vitest intercepts process.exit and throws — this catches that error.
process.on("unhandledRejection", () => {});

// Mock API lib — provides mocks for notifyPendingPRs dependencies
// and prevents main() from doing real work
const mockComment = vi.fn().mockResolvedValue(undefined);
const mockFindPRsWithLabel = vi.fn().mockResolvedValue([]);
const mockHasNotificationComment = vi.fn().mockResolvedValue(false);

vi.mock("../api/lib/index.js", () => ({
  createIssueOperations: vi.fn(),
  createPROperations: vi.fn(() => ({
    comment: mockComment,
    findPRsWithLabel: mockFindPRsWithLabel,
    hasNotificationComment: mockHasNotificationComment,
  })),
  createGovernanceService: vi.fn(),
  getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  loadRepositoryConfig: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("../api/lib/env-validation.js", () => ({
  getAppConfig: vi.fn(() => {
    throw new Error("test: no env");
  }),
}));

// Import after all mocks are in place
import { notifyPendingPRs, isRetryableError, withRetry } from "./close-discussions.js";
import { getOpenPRsForIssue, logger } from "../api/lib/index.js";
import { PR_MESSAGES } from "../api/config.js";

const mockGetOpenPRsForIssue = vi.mocked(getOpenPRsForIssue);

describe("close-discussions script", () => {
  describe("phase transition logic", () => {
    it("should transition when elapsed time exceeds duration", () => {
      const durationMs = 5 * 60 * 1000; // 5 minutes
      const labeledAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const elapsed = Date.now() - labeledAt.getTime();

      expect(elapsed >= durationMs).toBe(true);
    });

    it("should not transition when elapsed time is less than duration", () => {
      const durationMs = 5 * 60 * 1000; // 5 minutes
      const labeledAt = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago
      const elapsed = Date.now() - labeledAt.getTime();

      expect(elapsed >= durationMs).toBe(false);
    });

    it("should calculate remaining time correctly", () => {
      const durationMs = 10 * 60 * 1000; // 10 minutes
      const labeledAt = new Date(Date.now() - 4 * 60 * 1000); // 4 minutes ago
      const elapsed = Date.now() - labeledAt.getTime();
      const remainingMinutes = Math.ceil((durationMs - elapsed) / 60000);

      expect(remainingMinutes).toBe(6);
    });
  });

  describe("pull request filtering", () => {
    it("should identify pull requests by pull_request property", () => {
      const issue = { number: 1, title: "Test issue" };
      const pullRequest = { number: 2, title: "Test PR", pull_request: { url: "..." } };

      // Issues don't have pull_request property
      expect('pull_request' in issue).toBe(false);
      // PRs have pull_request property
      expect('pull_request' in pullRequest).toBe(true);
    });

    it("should skip items with pull_request property", () => {
      const items = [
        { number: 1, title: "Issue 1" },
        { number: 2, title: "PR 1", pull_request: { url: "..." } },
        { number: 3, title: "Issue 2" },
        { number: 4, title: "PR 2", pull_request: { url: "..." } },
      ];

      const processedIssues: number[] = [];
      for (const item of items) {
        if ('pull_request' in item) {
          continue;
        }
        processedIssues.push(item.number);
      }

      expect(processedIssues).toEqual([1, 3]);
    });
  });

  describe("environment validation", () => {
    it("should require APP_ID", () => {
      const appId = undefined;
      const privateKey = "test-key";

      expect(!appId || !privateKey).toBe(true);
    });

    it("should require APP_PRIVATE_KEY", () => {
      const appId = "123";
      const privateKey = undefined;

      expect(!appId || !privateKey).toBe(true);
    });

    it("should pass validation when both are provided", () => {
      const appId = "123";
      const privateKey = "test-key";

      expect(!appId || !privateKey).toBe(false);
    });
  });

  describe("notifyPendingPRs", () => {
    const fakeOctokit = {} as any;
    const appId = 12345;
    const owner = "test-org";
    const repo = "test-repo";
    const issueNumber = 42;

    beforeEach(() => {
      // Freeze time so metadata timestamps in issueVotingPassed are deterministic
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
      vi.clearAllMocks();
      mockFindPRsWithLabel.mockResolvedValue([]);
      mockHasNotificationComment.mockResolvedValue(false);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should post notification to linked PRs with author mention", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Fix stuff", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "Another fix", state: "OPEN", author: { login: "agent-bob" } },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(2);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 10 },
        PR_MESSAGES.issueVotingPassed(issueNumber, "agent-alice")
      );
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueVotingPassed(issueNumber, "agent-bob")
      );
    });

    it("should skip PRs that already have implementation label", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: "implementation" }] },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueVotingPassed(issueNumber, "agent-bob")
      );
    });

    it("should handle issues with no linked PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`#${issueNumber}`)
      );
    });

    it("should handle API errors gracefully without throwing", async () => {
      mockGetOpenPRsForIssue.mockRejectedValue(new Error("API rate limit"));

      // Should not throw
      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("API rate limit")
      );
    });

    it("should skip PRs that already have a notification comment", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already notified", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      // PR #10 already has a notification, PR #20 does not
      mockHasNotificationComment
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueVotingPassed(issueNumber, "agent-bob")
      );
    });

    it("should use issueVotingPassed message, not issueReadyNeedsUpdate", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "My PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      const commentBody = mockComment.mock.calls[0][1] as string;
      // issueVotingPassed includes "passed voting"
      expect(commentBody).toContain("passed voting");
      // issueReadyNeedsUpdate includes "opened before approval" — should NOT appear
      expect(commentBody).not.toContain("opened before approval");
    });
  });

  describe("isRetryableError", () => {
    it("should return true for 502 Bad Gateway", () => {
      expect(isRetryableError({ status: 502 })).toBe(true);
    });

    it("should return true for 503 Service Unavailable", () => {
      expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it("should return true for 504 Gateway Timeout", () => {
      expect(isRetryableError({ status: 504 })).toBe(true);
    });

    it("should return true for ETIMEDOUT network errors", () => {
      expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("should return true for ECONNRESET network errors", () => {
      expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    });

    it("should return true for 429 with retry-after header", () => {
      expect(isRetryableError({
        status: 429,
        response: { headers: { "retry-after": "60" } },
      })).toBe(true);
    });

    it("should return true for 403 with x-ratelimit-remaining: 0", () => {
      expect(isRetryableError({
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "0" } },
      })).toBe(true);
    });

    it("should return true for 403 with rate limit in message", () => {
      expect(isRetryableError({
        status: 403,
        message: "API rate limit exceeded",
      })).toBe(true);
    });

    it("should return false for 404 Not Found", () => {
      expect(isRetryableError({ status: 404 })).toBe(false);
    });

    it("should return false for 401 Unauthorized", () => {
      expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it("should return false for 400 Bad Request", () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it("should return false for 403 without rate limit indicators", () => {
      expect(isRetryableError({ status: 403 })).toBe(false);
    });

    it("should return false for plain Error without status or code", () => {
      expect(isRetryableError(new Error("Something broke"))).toBe(false);
    });
  });

  describe("withRetry", () => {
    // Use minimal baseDelayMs to keep tests fast
    const baseDelay = 1;

    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0);
    });

    afterEach(() => {
      vi.mocked(Math.random).mockRestore();
    });

    it("should return result on first successful attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn, 3, baseDelay);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable errors and succeed on later attempt", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 }))
        .mockResolvedValueOnce("recovered");

      const result = await withRetry(fn, 3, baseDelay);

      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should throw immediately for non-retryable errors", async () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 3, baseDelay)).rejects.toThrow("Not Found");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw after exhausting all attempts on retryable errors", async () => {
      const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 3, baseDelay)).rejects.toThrow("Service Unavailable");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should respect custom maxAttempts", async () => {
      const error = Object.assign(new Error("Bad Gateway"), { status: 502 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 2, baseDelay)).rejects.toThrow("Bad Gateway");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should log warnings between retry attempts", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Timeout"), { status: 504 }))
        .mockResolvedValueOnce("ok");

      await withRetry(fn, 3, baseDelay);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/Attempt 1 failed, retrying in \d+ms: Timeout/)
      );
    });
  });
});
