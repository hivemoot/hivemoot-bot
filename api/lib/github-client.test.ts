import { describe, it, expect, vi, beforeEach } from "vitest";
import { IssueOperations, createIssueOperations } from "./github-client.js";
import type { GitHubClient } from "./github-client.js";
import type { IssueRef } from "./types.js";
import { SIGNATURES, buildVotingComment, buildHumanHelpComment } from "./bot-comments.js";

/**
 * Helper to create a voting comment body with proper metadata.
 * Required since isVotingComment now requires metadata, not just signature.
 */
function createVotingCommentBody(issueNumber: number, cycle: number = 1): string {
  return buildVotingComment(`${SIGNATURES.VOTING} - cycle ${cycle}`, issueNumber, cycle);
}

/**
 * Tests for IssueOperations
 *
 * These tests verify the GitHub client abstraction:
 * - Label operations
 * - Comment operations
 * - Timeline API usage
 * - Error handling
 * - Runtime validation
 */

const TEST_APP_ID = 12345;

describe("createIssueOperations", () => {
  it("should create IssueOperations from valid client", () => {
    const validClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
          listEventsForTimeline: vi.fn(),
          listComments: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };

    const ops = createIssueOperations(validClient, { appId: TEST_APP_ID });
    expect(ops).toBeInstanceOf(IssueOperations);
  });

  it("should throw for null input", () => {
    expect(() => createIssueOperations(null, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for undefined input", () => {
    expect(() => createIssueOperations(undefined, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest property", () => {
    expect(() => createIssueOperations({ paginate: { iterator: vi.fn() } }, { appId: TEST_APP_ID })).toThrow(
      "Invalid GitHub client"
    );
  });

  it("should throw for object missing paginate.iterator", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
        },
      },
      paginate: {},
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing required issues methods", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          // missing addLabels, removeLabel, etc.
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should accept paginate as a function with iterator property (octokit v5+ style)", () => {
    // In octokit v5+, paginate is a callable function with an iterator property attached
    const paginateFunction = vi.fn() as ReturnType<typeof vi.fn> & { iterator: ReturnType<typeof vi.fn> };
    paginateFunction.iterator = vi.fn();

    const validClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
          listEventsForTimeline: vi.fn(),
          listComments: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
        },
      },
      paginate: paginateFunction,
    };

    const ops = createIssueOperations(validClient, { appId: TEST_APP_ID });
    expect(ops).toBeInstanceOf(IssueOperations);
  });

  it("should throw for null paginate", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
        },
      },
      paginate: null,
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });
});

describe("IssueOperations", () => {
  let mockClient: GitHubClient;
  let issueOps: IssueOperations;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockClient = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 5, "-1": 2, confused: 1 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    } as unknown as GitHubClient;

    issueOps = new IssueOperations(mockClient, TEST_APP_ID);
  });

  describe("addLabels", () => {
    it("should call GitHub API with correct parameters", async () => {
      await issueOps.addLabels(testRef, ["bug", "help-wanted"]);

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        labels: ["bug", "help-wanted"],
      });
    });
  });

  describe("removeLabel", () => {
    it("should call GitHub API with correct parameters", async () => {
      await issueOps.removeLabel(testRef, "phase:discussion");

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: "phase:discussion",
      });
    });

    it("should ignore 404 errors (label not found)", async () => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      // Should not throw
      await expect(issueOps.removeLabel(testRef, "nonexistent")).resolves.toBeUndefined();
    });

    it("should rethrow non-404 errors", async () => {
      const error = new Error("Server Error") as Error & { status: number };
      error.status = 500;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(issueOps.removeLabel(testRef, "label")).rejects.toThrow("Server Error");
    });
  });

  describe("comment", () => {
    it("should post comment with correct body", async () => {
      await issueOps.comment(testRef, "Hello world!");

      expect(mockClient.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: "Hello world!",
      });
    });
  });

  describe("close", () => {
    it("should close with default reason (not_planned)", async () => {
      await issueOps.close(testRef);

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        state: "closed",
        state_reason: "not_planned",
      });
    });

    it("should close with specified reason", async () => {
      await issueOps.close(testRef, "completed");

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state_reason: "completed" })
      );
    });
  });

  describe("lock", () => {
    it("should lock with default reason (resolved)", async () => {
      await issueOps.lock(testRef);

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        lock_reason: "resolved",
      });
    });

    it("should lock with specified reason", async () => {
      await issueOps.lock(testRef, "spam");

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith(
        expect.objectContaining({ lock_reason: "spam" })
      );
    });
  });

  describe("getVoteCounts", () => {
    it("should return reaction counts from issue", async () => {
      const votes = await issueOps.getVoteCounts(testRef);

      expect(votes).toEqual({ thumbsUp: 5, thumbsDown: 2, confused: 1 });
    });

    it("should return zeros when no reactions", async () => {
      vi.mocked(mockClient.rest.issues.get).mockResolvedValue({
        data: { reactions: undefined },
      });

      const votes = await issueOps.getVoteCounts(testRef);

      expect(votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0 });
    });
  });

  describe("findVotingCommentId", () => {
    it("should return comment ID when voting comment found with matching app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Some other comment", performed_via_github_app: null },
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 300, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should return null when voting comment not found", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Some comment", performed_via_github_app: null },
              { id: 200, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should return null when comments have no body", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 100, body: undefined, performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Page 1 comment", performed_via_github_app: null }] };
          yield { data: [{ id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } }] };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should ignore voting comments from different app IDs (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment - has signature but wrong app ID
              { id: 100, body: `${SIGNATURES.VOTING} - spoofed!`, performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // User comment with signature text (no app)
              { id: 200, body: `${SIGNATURES.VOTING} - user post`, performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should find legitimate comment even when spoofed comment exists", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment first (has metadata but wrong app ID)
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // Real bot comment
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should return highest cycle comment when multiple voting comments exist with metadata", async () => {
      // Simulates: issue went through discussion → voting (cycle 1) → needs-more-discussion → voting (cycle 2)
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Cycle 1 voting comment (older)
              {
                id: 100,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING} - cycle 1`,
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              // Cycle 2 voting comment (newer)
              {
                id: 200,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-20T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING} - cycle 2`,
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // Should return cycle 2 comment (highest cycle)
      expect(commentId).toBe(200);
    });

    it("should return first comment when multiple comments have same cycle", async () => {
      // Test edge case: same cycle number (shouldn't happen in practice)
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: createVotingCommentBody(42, 1),
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 200,
                body: createVotingCommentBody(42, 1),
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // With same cycle, returns first one in array order after sort
      expect(commentId).toBe(100);
    });

    it("should handle three voting cycles correctly", async () => {
      // Three cycles: initial → needs-more-discussion → voting → needs-more-discussion → voting
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-10T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-10T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 200,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 300,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":3,"createdAt":"2024-01-20T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // Should return cycle 3 comment
      expect(commentId).toBe(300);
    });
  });

  describe("countVotingComments", () => {
    it("should return 0 when no voting comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              { id: 200, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(0);
    });

    it("should count single voting comment", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: "Regular comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(1);
    });

    it("should count multiple voting comments", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: createVotingCommentBody(42, 2), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 300, body: createVotingCommentBody(42, 3), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(3);
    });

    it("should ignore voting comments from different app IDs", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: DIFFERENT_APP_ID } },
              { id: 300, body: createVotingCommentBody(42, 1), performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(1);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } }],
          };
          yield {
            data: [{ id: 200, body: createVotingCommentBody(42, 2), performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(2);
    });
  });

  describe("hasHumanHelpComment", () => {
    it("should return true when human help comment with matching error code exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              {
                id: 200,
                body: buildHumanHelpComment("Help needed!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(true);
    });

    it("should return false when no comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has different error code", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("Help!", 42, "OTHER_ERROR"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has wrong app ID (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("Spoofed!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: DIFFERENT_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has no app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("User posted!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: null,
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Page 1 comment", performed_via_github_app: null }] };
          yield {
            data: [
              {
                id: 200,
                body: buildHumanHelpComment("Found on page 2!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(true);
    });

    it("should return false when only regular comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Just a regular comment", performed_via_github_app: null },
              { id: 200, body: "Another regular comment", performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when comment body is null or undefined", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: null, performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: undefined, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });
  });

  describe("getValidatedVoteCounts", () => {
    it("should return valid votes and voters for single-reaction users", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "-1", user: { login: "Bob" } },
              { content: "confused", user: { login: "Charlie" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 1, confused: 1 });
      expect(result.voters).toEqual(expect.arrayContaining(["alice", "bob", "charlie"]));
      expect(result.voters).toHaveLength(3);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob", "charlie"]));
      expect(result.participants).toHaveLength(3);
    });

    it("should count duplicate identical reactions as a single vote", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: { login: "Alice" } }, // duplicate identical reaction
              { content: "+1", user: { login: "Bob" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 2, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.voters).toHaveLength(2);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.participants).toHaveLength(2);
    });

    it("should discard votes from users with multiple reaction types", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "-1", user: { login: "Alice" } }, // Alice has two reaction types — discard
              { content: "+1", user: { login: "Bob" } },   // Bob has only one — counts
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0 }); // only Bob
      expect(result.voters).toEqual(["bob"]);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.participants).toHaveLength(2);
    });

    it("should discard user with all three reaction types", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Spammer" } },
              { content: "-1", user: { login: "Spammer" } },
              { content: "confused", user: { login: "Spammer" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual(["spammer"]);
    });

    it("should ignore non-voting reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "heart", user: { login: "Alice" } },  // non-voting, ignored
              { content: "rocket", user: { login: "Bob" } },   // non-voting, ignored
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual(["alice"]);
      expect(result.participants).toEqual(["alice"]); // Bob has no voting reactions
    });

    it("should skip reactions without user", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: null },
              { content: "+1", user: { login: "Alice" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual(["alice"]);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ content: "+1", user: { login: "Alice" } }] };
          yield { data: [{ content: "-1", user: { login: "Alice" } }] }; // multi-reaction across pages
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      // Alice reacted with both +1 and -1 across pages — should be discarded
      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual(["alice"]);
    });

    it("should return empty results when no reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual([]);
    });
  });

  describe("getLabelAddedTime", () => {
    it("should return date when label event found", async () => {
      const labeledDate = "2024-01-15T10:30:00Z";

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { event: "opened", created_at: "2024-01-15T10:00:00Z" },
              { event: "labeled", label: { name: "phase:discussion" }, created_at: labeledDate },
              { event: "commented", created_at: "2024-01-15T11:00:00Z" },
            ],
          };
        },
      });

      const result = await issueOps.getLabelAddedTime(testRef, "phase:discussion");

      expect(result).toEqual(new Date(labeledDate));
    });

    it("should return null when label not found", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { event: "opened", created_at: "2024-01-15T10:00:00Z" },
              { event: "labeled", label: { name: "other-label" }, created_at: "2024-01-15T10:30:00Z" },
            ],
          };
        },
      });

      const result = await issueOps.getLabelAddedTime(testRef, "phase:discussion");

      expect(result).toBeNull();
    });
  });

  describe("transition", () => {
    it("should add label and comment", async () => {
      await issueOps.transition(testRef, {
        addLabel: "phase:voting",
        comment: "Voting has started!",
      });

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalled();
      expect(mockClient.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should remove label when specified", async () => {
      await issueOps.transition(testRef, {
        removeLabel: "phase:discussion",
        addLabel: "phase:voting",
        comment: "Moving to voting",
      });

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "phase:discussion" })
      );
    });

    it("should close issue when specified", async () => {
      await issueOps.transition(testRef, {
        addLabel: "rejected",
        comment: "Rejected",
        close: true,
        closeReason: "not_planned",
      });

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" })
      );
    });

    it("should lock issue when specified", async () => {
      await issueOps.transition(testRef, {
        addLabel: "phase:ready-to-implement",
        comment: "Ready to implement",
        lock: true,
        lockReason: "resolved",
      });

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith(
        expect.objectContaining({ lock_reason: "resolved" })
      );
    });

    it("should run operations sequentially to prevent race conditions", async () => {
      const callOrder: string[] = [];

      vi.mocked(mockClient.rest.issues.removeLabel).mockImplementation(async () => {
        callOrder.push("removeLabel");
      });
      vi.mocked(mockClient.rest.issues.addLabels).mockImplementation(async () => {
        callOrder.push("addLabels");
      });
      vi.mocked(mockClient.rest.issues.createComment).mockImplementation(async () => {
        callOrder.push("createComment");
      });
      vi.mocked(mockClient.rest.issues.update).mockImplementation(async () => {
        callOrder.push("close");
      });
      vi.mocked(mockClient.rest.issues.lock).mockImplementation(async () => {
        callOrder.push("lock");
      });

      await issueOps.transition(testRef, {
        removeLabel: "old",
        addLabel: "new",
        comment: "Transitioning",
        close: true,
        lock: true,
      });

      // Verify operations happen in the correct order
      expect(callOrder).toEqual(["removeLabel", "addLabels", "createComment", "close", "lock"]);
    });

    it("should complete comment before lock so users can see the message", async () => {
      let commentCompleted = false;
      let lockCalledBeforeComment = false;

      vi.mocked(mockClient.rest.issues.createComment).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        commentCompleted = true;
      });

      vi.mocked(mockClient.rest.issues.lock).mockImplementation(async () => {
        if (!commentCompleted) {
          lockCalledBeforeComment = true;
        }
      });

      await issueOps.transition(testRef, {
        addLabel: "rejected",
        comment: "Rejected",
        lock: true,
      });

      expect(lockCalledBeforeComment).toBe(false);
      expect(commentCompleted).toBe(true);
    });
  });

  describe("getIssueDetails", () => {
    it("should return issue title, body, and author", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Add feature X",
          body: "We need feature X for better UX",
          user: { login: "alice" },
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details).toEqual({
        title: "Add feature X",
        body: "We need feature X for better UX",
        author: "alice",
      });
    });

    it("should handle null body", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Quick fix",
          body: null,
          user: { login: "bob" },
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details.body).toBe("");
    });

    it("should handle null user", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "No author",
          body: "Some body",
          user: null,
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details.author).toBe("");
    });
  });

  describe("getDiscussionComments", () => {
    it("should return human comments with author info", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Great idea!",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "I agree",
                user: { login: "bob", type: "User" },
                created_at: "2024-01-15T11:00:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        author: "alice",
        body: "Great idea!",
        createdAt: "2024-01-15T10:00:00Z",
      });
    });

    it("should filter out Queen bot comments (performed_via_github_app)", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Human comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "Bot welcome message",
                user: { login: "queen-bot[bot]", type: "Bot" },
                created_at: "2024-01-15T10:01:00Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("should INCLUDE comments from other bots (only filter our own app)", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Human comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "Dependabot update",
                user: { login: "dependabot", type: "Bot" },
                created_at: "2024-01-15T10:01:00Z",
              },
              {
                id: 3,
                body: "GitHub Actions message",
                user: { login: "github-actions[bot]", type: "Bot" },
                created_at: "2024-01-15T10:02:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      // All comments included - we only filter our own app's comments
      expect(comments).toHaveLength(3);
      expect(comments[0].author).toBe("alice");
      expect(comments[1].author).toBe("dependabot");
      expect(comments[2].author).toBe("github-actions[bot]");
    });

    it("should skip comments without user or body", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Valid comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: null,
                user: { login: "bob", type: "User" },
                created_at: "2024-01-15T10:01:00Z",
              },
              {
                id: 3,
                body: "Missing user",
                user: null,
                created_at: "2024-01-15T10:02:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Page 1", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
            ],
          };
          yield {
            data: [
              { id: 2, body: "Page 2", user: { login: "bob" }, created_at: "2024-01-02T00:00:00Z" },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(2);
    });
  });

  describe("getIssueContext", () => {
    it("should combine issue details and comments", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Feature Request",
          body: "Please add this feature",
          user: { login: "bob" },
        },
      });

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Good idea!", user: { login: "alice" }, created_at: "2024-01-15T10:00:00Z" },
            ],
          };
        },
      });

      const context = await issueOps.getIssueContext(testRef);

      expect(context.title).toBe("Feature Request");
      expect(context.body).toBe("Please add this feature");
      expect(context.author).toBe("bob");
      expect(context.comments).toHaveLength(1);
      expect(context.comments[0].author).toBe("alice");
    });

    it("should fetch details and comments in parallel", async () => {
      // Use fake timers for deterministic test execution
      vi.useFakeTimers();

      try {
        // Track execution order to verify parallel execution
        const executionOrder: string[] = [];

        mockClient.rest.issues.get = vi.fn().mockImplementation(async () => {
          executionOrder.push("get-start");
          await new Promise((r) => setTimeout(r, 100));
          executionOrder.push("get-end");
          return { data: { title: "Test", body: "Body", user: { login: "testAuthor" } } };
        });

        mockClient.paginate.iterator = vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            executionOrder.push("list-start");
            await new Promise((r) => setTimeout(r, 100));
            executionOrder.push("list-end");
            yield { data: [] };
          },
        });

        // Start the operation but don't await yet
        const resultPromise = issueOps.getIssueContext(testRef);

        // Allow microtasks to process (both operations should start)
        await vi.advanceTimersByTimeAsync(0);

        // Verify both operations started before advancing timers
        expect(executionOrder).toContain("get-start");
        expect(executionOrder).toContain("list-start");
        expect(executionOrder).not.toContain("get-end");
        expect(executionOrder).not.toContain("list-end");

        // Now advance timers to complete both operations
        await vi.advanceTimersByTimeAsync(100);

        // Wait for the result
        await resultPromise;

        // Both operations should start before either finishes (parallel execution)
        // If sequential: get-start, get-end, list-start, list-end
        // If parallel: get-start, list-start, (get-end|list-end in any order)
        expect(executionOrder[0]).toBe("get-start");
        expect(executionOrder[1]).toBe("list-start");
        // Both started before first ended = parallel execution confirmed
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
