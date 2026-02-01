import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for reconcile-pr-notifications script
 *
 * Tests the reconciliation functions:
 * - hasVotingPassedNotification: duplicate detection (metadata + fallback)
 * - reconcileIssue: notification logic, skipping, error handling
 * - processRepository: filtering, issue iteration
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

// Suppress unhandled rejection from module-level main().catch() calling process.exit(1)
process.on("unhandledRejection", () => {});

// Mock API lib
const mockComment = vi.fn().mockResolvedValue(undefined);
const mockFindPRsWithLabel = vi.fn().mockResolvedValue([]);
const mockHasNotificationCommentInComments = vi.fn().mockReturnValue(false);
const mockListCommentsWithBody = vi.fn().mockResolvedValue([]);

vi.mock("../api/lib/index.js", () => ({
  createPROperations: vi.fn(() => ({
    comment: mockComment,
    findPRsWithLabel: mockFindPRsWithLabel,
    hasNotificationCommentInComments: mockHasNotificationCommentInComments,
    listCommentsWithBody: mockListCommentsWithBody,
  })),
  getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
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
import {
  hasVotingPassedNotification,
  reconcileIssue,
  processRepository,
} from "./reconcile-pr-notifications.js";
import { getOpenPRsForIssue, createPROperations, logger } from "../api/lib/index.js";
import { PR_MESSAGES, LABELS } from "../api/config.js";
import { NOTIFICATION_TYPES } from "../api/lib/bot-comments.js";
import type { PROperations } from "../api/lib/pr-operations.js";
import type { PRRef } from "../api/lib/index.js";

const mockGetOpenPRsForIssue = vi.mocked(getOpenPRsForIssue);

describe("reconcile-pr-notifications", () => {
  const appId = 12345;
  const owner = "test-org";
  const repo = "test-repo";
  const fakeOctokit = {} as any;

  beforeEach(() => {
    // Freeze time so metadata timestamps in issueVotingPassed are deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
    vi.clearAllMocks();
    mockFindPRsWithLabel.mockResolvedValue([]);
    mockHasNotificationCommentInComments.mockReturnValue(false);
    mockListCommentsWithBody.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("hasVotingPassedNotification", () => {
    const ref: PRRef = { owner, repo, prNumber: 10 };
    const mockPRs = {
      hasNotificationCommentInComments: mockHasNotificationCommentInComments,
      listCommentsWithBody: mockListCommentsWithBody,
    } as unknown as PROperations;

    it("should return true when metadata-tagged notification exists", async () => {
      const comments = [
        { id: 1, body: "metadata comment", performed_via_github_app: { id: appId } },
      ];
      mockListCommentsWithBody.mockResolvedValue(comments);
      mockHasNotificationCommentInComments.mockReturnValue(true);

      const result = await hasVotingPassedNotification(mockPRs, ref, 42);

      expect(result).toBe(true);
      expect(mockListCommentsWithBody).toHaveBeenCalledWith(ref);
      expect(mockHasNotificationCommentInComments).toHaveBeenCalledWith(
        comments,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );
    });

    it("should return true when pre-metadata comment matches (fallback)", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #42 Ready to Implement ✅\n\nGood news @agent — Issue #42 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasVotingPassedNotification(mockPRs, ref, 42);

      expect(result).toBe(true);
    });

    it("should return false when no matching comments exist", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const result = await hasVotingPassedNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });

    it("should return false when fallback comment is for different issue", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #99 Ready to Implement ✅\n\nIssue #99 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasVotingPassedNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });

    it("should return false when comment body is unrelated", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        { id: 1, body: "Great work on this PR!" },
        { id: 2, body: "LGTM" },
      ]);

      const result = await hasVotingPassedNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });
  });

  describe("reconcileIssue", () => {
    it("should post notification to un-notified PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Fix stuff", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "Another fix", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const result = await reconcileIssue(fakeOctokit, createPROperations(fakeOctokit, { appId }) as unknown as PROperations, owner, repo, 42);

      expect(result).toEqual({ notified: 2, skipped: 0 });
      expect(mockComment).toHaveBeenCalledTimes(2);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 10 },
        PR_MESSAGES.issueVotingPassed(42, "agent-alice")
      );
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueVotingPassed(42, "agent-bob")
      );
    });

    it("should skip PRs with implementation label", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]);

      const result = await reconcileIssue(fakeOctokit, createPROperations(fakeOctokit, { appId }) as unknown as PROperations, owner, repo, 42);

      expect(result).toEqual({ notified: 1, skipped: 1 });
      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueVotingPassed(42, "agent-bob")
      );
    });

    it("should skip PRs that already have notification", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(true);

      const result = await reconcileIssue(fakeOctokit, createPROperations(fakeOctokit, { appId }) as unknown as PROperations, owner, repo, 42);

      expect(result).toEqual({ notified: 0, skipped: 1 });
      expect(mockComment).not.toHaveBeenCalled();
    });

    it("should handle no linked PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([]);

      const result = await reconcileIssue(fakeOctokit, createPROperations(fakeOctokit, { appId }) as unknown as PROperations, owner, repo, 42);

      expect(result).toEqual({ notified: 0, skipped: 0 });
      expect(mockComment).not.toHaveBeenCalled();
    });
  });

  describe("processRepository", () => {
    /** Create a mock octokit with paginate.iterator returning one page of items */
    function createMockOctokit(items: any[]) {
      const mockListForRepo = vi.fn();
      return {
        octokit: {
          paginate: {
            iterator: vi.fn().mockImplementation(() =>
              (async function* () {
                yield { data: items };
              })()
            ),
          },
          rest: {
            issues: { listForRepo: mockListForRepo },
          },
        } as any,
        mockListForRepo,
      };
    }

    it("should process ready-to-implement issues", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      mockGetOpenPRsForIssue.mockResolvedValue([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockOctokit.paginate.iterator).toHaveBeenCalledWith(
        mockOctokit.rest.issues.listForRepo,
        {
          owner,
          repo,
          state: "open",
          labels: LABELS.READY_TO_IMPLEMENT,
          per_page: 100,
        }
      );
    });

    it("should skip items with pull_request property (PRs, not issues)", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }], pull_request: { url: "..." } },
      ]);

      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent" } },
      ]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      // getOpenPRsForIssue should only be called for issue #42 (not #43 which is a PR)
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledTimes(1);
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledWith(mockOctokit, owner, repo, 42);
    });

    it("should handle empty repository (no ready issues)", async () => {
      const { octokit: mockOctokit } = createMockOctokit([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockGetOpenPRsForIssue).not.toHaveBeenCalled();
    });

    it("should continue after per-issue errors, then throw aggregate error", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      // First issue fails, second succeeds
      mockGetOpenPRsForIssue
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };

      // Should throw aggregate error after processing all issues
      await expect(processRepository(mockOctokit, repoObj, appId)).rejects.toThrow(
        "Failed to reconcile 1 issue(s): #42"
      );

      // Should log error for first issue but still process second
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("#42"),
        expect.any(Error)
      );
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledTimes(2);
    });
  });
});
