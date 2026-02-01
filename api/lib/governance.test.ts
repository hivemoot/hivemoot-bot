import { describe, it, expect, vi, beforeEach } from "vitest";
import { GovernanceService, createGovernanceService } from "./governance.js";
import type { IssueOperations } from "./github-client.js";
import type { IssueRef, VoteCounts } from "./types.js";
import { LABELS, MESSAGES, SIGNATURE } from "../config.js";
import { SIGNATURES, ERROR_CODES } from "./bot-comments.js";
import { createModelFromEnv } from "./llm/provider.js";
import { DiscussionSummarizer, formatVotingMessage } from "./llm/summarizer.js";

// Mock LLM provider to control createModelFromEnv behavior
vi.mock("./llm/provider.js", () => ({
  createModelFromEnv: vi.fn(() => null), // Default: LLM not configured
}));

// Mock summarizer
vi.mock("./llm/summarizer.js", () => ({
  DiscussionSummarizer: vi.fn(),
  formatVotingMessage: vi.fn(() => "Formatted voting message with LLM summary"),
}));

/**
 * Tests for GovernanceService
 *
 * These tests verify the governance business logic:
 * - Phase transitions
 * - Voting outcome determination
 */

describe("GovernanceService", () => {
  let mockIssues: IssueOperations;
  let governance: GovernanceService;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockIssues = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      getVoteCounts: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0 }),
      findVotingCommentId: vi.fn().mockResolvedValue(12345),
      getVoteCountsFromComment: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0 }),
      countVotingComments: vi.fn().mockResolvedValue(0),
      hasHumanHelpComment: vi.fn().mockResolvedValue(false),
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date()),
      transition: vi.fn().mockResolvedValue(undefined),
      // getIssueContext should NOT be called when LLM is not configured
      getIssueContext: vi.fn(),
    } as unknown as IssueOperations;

    governance = new GovernanceService(mockIssues);
  });

  describe("startDiscussion", () => {
    it("should add phase:discussion label and post welcome comment", async () => {
      await governance.startDiscussion(testRef);

      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.DISCUSSION]);
      expect(mockIssues.comment).toHaveBeenCalledWith(testRef, MESSAGES.ISSUE_WELCOME);
    });

    it("should run label and comment in parallel", async () => {
      const addLabelsPromise = new Promise((resolve) => setTimeout(resolve, 10));
      const commentPromise = new Promise((resolve) => setTimeout(resolve, 10));

      vi.mocked(mockIssues.addLabels).mockReturnValue(addLabelsPromise as Promise<void>);
      vi.mocked(mockIssues.comment).mockReturnValue(commentPromise as Promise<void>);

      const startTime = Date.now();
      await governance.startDiscussion(testRef);
      const elapsed = Date.now() - startTime;

      // If run in parallel, should take ~10ms, not ~20ms
      expect(elapsed).toBeLessThan(20);
    });
  });

  describe("transitionToVoting", () => {
    it("should call transition with generic message when LLM not configured", async () => {
      await governance.transitionToVoting(testRef);

      // Should NOT fetch issue context when LLM is not configured (avoids unnecessary API calls)
      expect(mockIssues.getIssueContext).not.toHaveBeenCalled();
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.DISCUSSION,
        addLabel: LABELS.VOTING,
        comment: expect.stringContaining(MESSAGES.VOTING_START),
      });
      // Verify metadata is prepended
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toMatch(/^<!-- hivemoot-metadata:/);
      expect(callArgs.comment).toContain('"type":"voting"');
      expect(callArgs.comment).toContain('"cycle":1');
    });

    it("should skip GitHub API call when API key is missing (createModelFromEnv throws)", async () => {
      // Simulate API key missing - createModelFromEnv throws instead of returning null
      vi.mocked(createModelFromEnv).mockImplementation(() => {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      });

      await governance.transitionToVoting(testRef);

      // Critical: Should NOT fetch issue context when API key is missing
      // This is the core behavior this fix addresses
      expect(mockIssues.getIssueContext).not.toHaveBeenCalled();
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.DISCUSSION,
        addLabel: LABELS.VOTING,
        comment: expect.stringContaining(MESSAGES.VOTING_START),
      });
    });

    describe("with LLM configured", () => {
      const mockSummary = {
        proposal: "Test proposal",
        alignedOn: ["Point 1"],
        openForPR: [],
        notIncluded: [],
        metadata: { commentCount: 5, participantCount: 3 },
      };

      const mockContext = {
        title: "Test Issue",
        body: "Issue body",
        author: "testuser",
        comments: [{ body: "Comment", author: "user1" }],
      };

      // Mock model result returned by createModelFromEnv when LLM is configured
      const mockModelResult = {
        model: {} as never, // Mock LanguageModelV1
        config: { provider: "anthropic" as const, model: "claude-3-haiku", maxTokens: 2000 },
      };

      beforeEach(() => {
        // Enable LLM by returning a mock model result
        vi.mocked(createModelFromEnv).mockReturnValue(mockModelResult);

        // Setup mock issue context
        vi.mocked(mockIssues.getIssueContext).mockResolvedValue(mockContext);
      });

      it("should use LLM summary when configured and successful", async () => {
        // Setup successful summarization
        const mockSummarize = vi.fn().mockResolvedValue({
          success: true,
          summary: mockSummary,
        });
        vi.mocked(DiscussionSummarizer).mockImplementation(() => ({
          summarize: mockSummarize,
        }));

        await governance.transitionToVoting(testRef);

        expect(mockIssues.getIssueContext).toHaveBeenCalledWith(testRef);
        expect(DiscussionSummarizer).toHaveBeenCalled();
        // Now passes the pre-created model as second argument
        expect(mockSummarize).toHaveBeenCalledWith(mockContext, mockModelResult);
        expect(formatVotingMessage).toHaveBeenCalledWith(
          mockSummary,
          mockContext.title,
          SIGNATURE,
          SIGNATURES.VOTING
        );
        // Verify comment includes both metadata and LLM message
        const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
        expect(callArgs.comment).toMatch(/^<!-- hivemoot-metadata:/);
        expect(callArgs.comment).toContain("Formatted voting message with LLM summary");
      });

      it("should fall back to generic message when LLM summarization fails", async () => {
        const mockSummarize = vi.fn().mockResolvedValue({
          success: false,
          reason: "API rate limited",
        });
        vi.mocked(DiscussionSummarizer).mockImplementation(() => ({
          summarize: mockSummarize,
        }));

        await governance.transitionToVoting(testRef);

        expect(mockIssues.getIssueContext).toHaveBeenCalledWith(testRef);
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.VOTING_START),
        });
      });

      it("should fall back to generic message when LLM throws an error", async () => {
        const mockSummarize = vi.fn().mockRejectedValue(new Error("Network error"));
        vi.mocked(DiscussionSummarizer).mockImplementation(() => ({
          summarize: mockSummarize,
        }));

        await governance.transitionToVoting(testRef);

        // Should still complete the transition with generic message
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.VOTING_START),
        });
      });

      it("should fall back to generic message when getIssueContext throws", async () => {
        vi.mocked(mockIssues.getIssueContext).mockRejectedValue(new Error("GitHub API error"));

        await governance.transitionToVoting(testRef);

        // Should still complete the transition with generic message
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.VOTING_START),
        });
      });

      it("should handle non-Error exceptions gracefully", async () => {
        vi.mocked(mockIssues.getIssueContext).mockRejectedValue("string error");

        await governance.transitionToVoting(testRef);

        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.VOTING_START),
        });
      });
    });
  });

  describe("endVoting", () => {
    it("should mark phase:ready-to-implement when thumbsUp > thumbsDown", async () => {
      const votes: VoteCounts = { thumbsUp: 5, thumbsDown: 2, confused: 1 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("phase:ready-to-implement");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.getVoteCountsFromComment).toHaveBeenCalledWith(testRef, 12345);
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.READY_TO_IMPLEMENT,
        comment: MESSAGES.votingEndReadyToImplement(votes),
        close: false,
        // closeReason not passed when close: false
        lock: false,
        // lockReason not passed when lock: false
      });
    });

    it("should reject and close when thumbsDown > thumbsUp", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 5, confused: 0 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("rejected");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.REJECTED,
        comment: MESSAGES.votingEndRejected(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should be inconclusive when votes are tied", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 3, confused: 2 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.INCONCLUSIVE,
        comment: MESSAGES.votingEndInconclusive(votes),
        close: false,
        // closeReason not passed when close: false
        lock: false,
        // lockReason not passed when lock: false
      });
    });

    it("should be inconclusive when no votes", async () => {
      const votes: VoteCounts = { thumbsUp: 0, thumbsDown: 0, confused: 0 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("inconclusive");
    });

    it("should return to discussion when confused > thumbsUp + thumbsDown (needs-more-discussion)", async () => {
      const votes: VoteCounts = { thumbsUp: 2, thumbsDown: 1, confused: 5 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("needs-more-discussion");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.DISCUSSION,
        comment: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      });
    });

    it("should NOT trigger needs-more-discussion when confused equals thumbsUp + thumbsDown", async () => {
      // confused (3) = thumbsUp (2) + thumbsDown (1) - should NOT trigger needs-more-discussion
      const votes: VoteCounts = { thumbsUp: 2, thumbsDown: 1, confused: 3 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.endVoting(testRef);

      // Should proceed with normal outcome (thumbsUp > thumbsDown)
      expect(outcome).toBe("phase:ready-to-implement");
    });

    it("should return skipped and post human help when voting comment not found", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      expect(mockIssues.comment).toHaveBeenCalled();
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.BLOCKED_HUMAN_HELP]);
      expect(mockIssues.getVoteCountsFromComment).not.toHaveBeenCalled();
    });

    it("should skip posting duplicate human help comment", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(true);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.comment).not.toHaveBeenCalled();
      expect(mockIssues.addLabels).not.toHaveBeenCalled();
    });

    it("should still return skipped when addLabels fails (label may not exist)", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.addLabels).mockRejectedValue(new Error("Label not found"));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.comment).toHaveBeenCalled();
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.BLOCKED_HUMAN_HELP]);
    });
  });

  describe("resolveInconclusive", () => {
    it("should transition to ready-to-implement when thumbsUp > thumbsDown after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 5, thumbsDown: 2, confused: 1 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("phase:ready-to-implement");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.getVoteCountsFromComment).toHaveBeenCalledWith(testRef, 12345);
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.INCONCLUSIVE,
        addLabel: LABELS.READY_TO_IMPLEMENT,
        comment: MESSAGES.votingEndInconclusiveResolved(votes, "phase:ready-to-implement"),
        close: false,
        lock: false,
        // lockReason not passed when lock: false
      });
    });

    it("should transition to rejected when thumbsDown > thumbsUp after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 5, confused: 0 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("rejected");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.INCONCLUSIVE,
        addLabel: LABELS.REJECTED,
        comment: MESSAGES.votingEndInconclusiveResolved(votes, "rejected"),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should close and lock when still tied after extended voting (final)", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 3, confused: 2 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.INCONCLUSIVE,
        addLabel: LABELS.INCONCLUSIVE,
        comment: MESSAGES.votingEndInconclusiveFinal(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should close and lock when no votes after extended voting (final)", async () => {
      const votes: VoteCounts = { thumbsUp: 0, thumbsDown: 0, confused: 0 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.INCONCLUSIVE,
        addLabel: LABELS.INCONCLUSIVE,
        comment: MESSAGES.votingEndInconclusiveFinal(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should return skipped and post human help when voting comment not found", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      expect(mockIssues.comment).toHaveBeenCalled();
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.BLOCKED_HUMAN_HELP]);
      expect(mockIssues.getVoteCountsFromComment).not.toHaveBeenCalled();
    });

    it("should skip posting duplicate human help comment in resolveInconclusive", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(true);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.comment).not.toHaveBeenCalled();
    });

    it("should return to discussion when confused > thumbsUp + thumbsDown after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 2, confused: 6 };
      vi.mocked(mockIssues.getVoteCountsFromComment).mockResolvedValue(votes);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("needs-more-discussion");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.INCONCLUSIVE,
        addLabel: LABELS.DISCUSSION,
        comment: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      });
    });
  });
});

describe("GovernanceService voting cycle tracking", () => {
  let mockIssues: IssueOperations;
  let governance: GovernanceService;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockIssues = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      getVoteCounts: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0 }),
      findVotingCommentId: vi.fn().mockResolvedValue(12345),
      getVoteCountsFromComment: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0 }),
      countVotingComments: vi.fn().mockResolvedValue(0),
      hasHumanHelpComment: vi.fn().mockResolvedValue(false),
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date()),
      transition: vi.fn().mockResolvedValue(undefined),
      getIssueContext: vi.fn(),
    } as unknown as IssueOperations;

    governance = new GovernanceService(mockIssues);
  });

  it("should include cycle:1 in metadata for first voting transition", async () => {
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(0);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":1');
    expect(callArgs.comment).toContain('"issueNumber":42');
  });

  it("should include cycle:2 in metadata for second voting transition (after needs-more-discussion)", async () => {
    // Simulate one existing voting comment
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(1);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":2');
  });

  it("should include cycle:3 in metadata for third voting transition", async () => {
    // Simulate two existing voting comments
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(2);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":3');
  });

  it("should call countVotingComments to determine cycle number", async () => {
    await governance.transitionToVoting(testRef);

    expect(mockIssues.countVotingComments).toHaveBeenCalledWith(testRef);
  });
});

describe("createGovernanceService", () => {
  const mockIssues = {
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    comment: vi.fn(),
    close: vi.fn(),
    lock: vi.fn(),
    getVoteCounts: vi.fn(),
    findVotingCommentId: vi.fn(),
    getVoteCountsFromComment: vi.fn(),
    countVotingComments: vi.fn(),
    hasHumanHelpComment: vi.fn(),
    getLabelAddedTime: vi.fn(),
    transition: vi.fn(),
    getIssueContext: vi.fn(),
  } as unknown as IssueOperations;

  it("should throw if issues is null", () => {
    expect(() => createGovernanceService(null as unknown as IssueOperations)).toThrow(
      "Invalid IssueOperations: expected a valid IssueOperations instance"
    );
  });

  it("should throw if issues is undefined", () => {
    expect(() => createGovernanceService(undefined as unknown as IssueOperations)).toThrow(
      "Invalid IssueOperations: expected a valid IssueOperations instance"
    );
  });

  it("should create service with valid issues", () => {
    const service = createGovernanceService(mockIssues);
    expect(service).toBeInstanceOf(GovernanceService);
  });

  it("should accept optional config with logger", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      group: vi.fn(),
      groupEnd: vi.fn(),
    };

    const service = createGovernanceService(mockIssues, { logger: mockLogger });
    expect(service).toBeInstanceOf(GovernanceService);
  });
});
