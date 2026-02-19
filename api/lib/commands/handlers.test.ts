import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand, type CommandContext } from "./handlers.js";
import { LABELS, REQUIRED_REPOSITORY_LABELS } from "../../config.js";

// Mock the governance/issue operations modules
vi.mock("../index.js", () => ({
  createIssueOperations: vi.fn(() => mockIssueOps),
  createGovernanceService: vi.fn(() => mockGovernance),
  createRepositoryLabelService: vi.fn(() => mockLabelService),
  loadRepositoryConfig: vi.fn().mockResolvedValue({
    version: 1,
    governance: {
      proposals: {
        discussion: { exits: [{ type: "manual" }], durationMs: 0 },
        voting: { exits: [{ type: "manual" }], durationMs: 0 },
        extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
      },
      pr: {
        staleDays: 3,
        maxPRsPerIssue: 3,
        trustedReviewers: ["alice"],
        intake: [{ method: "update" }],
        mergeReady: null,
      },
    },
    standup: {
      enabled: false,
      category: "",
    },
  }),
}));

vi.mock("../discussions.js", () => ({
  getRepoDiscussionInfo: vi.fn().mockResolvedValue({
    repoId: "repo-id",
    repoCreatedAt: "2026-02-15T00:00:00.000Z",
    hasDiscussions: true,
    categories: [{ id: "cat-1", name: "Hivemoot Reports" }],
  }),
}));

vi.mock("../llm/provider.js", () => ({
  getLLMReadiness: vi.fn(() => ({ ready: false, reason: "not_configured" })),
}));

// Mock the blueprint generator to control success/failure paths.
// vi.hoisted ensures the mock fn is available before vi.mock runs.
const { mockBlueprintGenerate } = vi.hoisted(() => ({
  mockBlueprintGenerate: vi.fn(),
}));
vi.mock("../llm/blueprint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/blueprint.js")>();
  return {
    ...actual,
    BlueprintGenerator: class {
      generate = mockBlueprintGenerate;
    },
  };
});

let mockIssueOps: Record<string, ReturnType<typeof vi.fn>>;
let mockGovernance: Record<string, ReturnType<typeof vi.fn>>;
let mockLabelService: Record<string, ReturnType<typeof vi.fn>>;

function createMockOctokit(permission = "admin") {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("version: 1\n").toString("base64"),
          },
        }),
        get: vi.fn().mockResolvedValue({ data: {} }),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
        createLabel: vi.fn().mockResolvedValue({}),
        updateLabel: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
    paginate: {
      iterator: vi.fn().mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      })),
    },
    graphql: vi.fn().mockResolvedValue({}),
  };
}

function createCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    octokit: createMockOctokit(),
    owner: "test-org",
    repo: "test-repo",
    issueNumber: 42,
    commentId: 100,
    senderLogin: "maintainer",
    verb: "vote",
    freeText: undefined,
    issueLabels: [{ name: LABELS.DISCUSSION }],
    isPullRequest: false,
    appId: 12345,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("executeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueOps = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      transition: vi.fn().mockResolvedValue(undefined),
      findVotingCommentId: vi.fn().mockResolvedValue(null),
      countVotingComments: vi.fn().mockResolvedValue(0),
      getIssueContext: vi.fn(),
      findAlignmentCommentId: vi.fn().mockResolvedValue(null),
    };
    mockGovernance = {
      transitionToVoting: vi.fn().mockResolvedValue(undefined),
    };
    mockLabelService = {
      ensureRequiredLabels: vi.fn().mockResolvedValue({
        created: 2,
        renamed: 1,
        updated: 0,
        skipped: REQUIRED_REPOSITORY_LABELS.length - 3,
        renamedLabels: [{ from: "phase:voting", to: "hivemoot:voting" }],
      }),
    };
    // Default: LLM not configured → fallback blueprint
    mockBlueprintGenerate.mockResolvedValue({
      success: false,
      reason: "LLM not configured",
    });
  });

  describe("authorization", () => {
    it("should silently ignore commands from users without write access", async () => {
      const ctx = createCtx({
        octokit: createMockOctokit("read"),
      });

      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "ignored" });
      // Should not react or reply
      expect(ctx.octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
    });

    it("should silently ignore commands from triage-level users", async () => {
      const ctx = createCtx({
        octokit: createMockOctokit("triage"),
      });

      const result = await executeCommand(ctx);
      expect(result).toEqual({ status: "ignored" });
    });

    it("should allow admin users", async () => {
      const ctx = createCtx({
        octokit: createMockOctokit("admin"),
      });

      const result = await executeCommand(ctx);
      expect(result.status).toBe("executed");
    });

    it("should allow maintain-level users", async () => {
      const ctx = createCtx({
        octokit: createMockOctokit("maintain"),
      });

      const result = await executeCommand(ctx);
      expect(result.status).toBe("executed");
    });

    it("should allow write-level users", async () => {
      const ctx = createCtx({
        octokit: createMockOctokit("write"),
      });

      const result = await executeCommand(ctx);
      expect(result.status).toBe("executed");
    });

    it("should ignore when permission check fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(
        new Error("Not found"),
      );

      const result = await executeCommand(createCtx({ octokit }));
      expect(result).toEqual({ status: "ignored" });
    });
  });

  describe("unknown commands", () => {
    it("should ignore unknown command verbs", async () => {
      const result = await executeCommand(createCtx({ verb: "unknown" }));
      expect(result).toEqual({ status: "ignored" });
    });
  });

  describe("/vote command", () => {
    it("should transition issue from discussion to voting", async () => {
      const ctx = createCtx();
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "executed", message: "Moved to voting phase." });
      expect(mockGovernance.transitionToVoting).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-org",
          repo: "test-repo",
          issueNumber: 42,
        })
      );
    });

    it("should add eyes reaction on receipt and thumbs up on success", async () => {
      const ctx = createCtx();
      await executeCommand(ctx);

      const reactionCalls = ctx.octokit.rest.reactions.createForIssueComment.mock.calls;
      expect(reactionCalls).toHaveLength(2);
      expect(reactionCalls[0][0].content).toBe("eyes");
      expect(reactionCalls[1][0].content).toBe("+1");
    });

    it("should reject /vote on a PR", async () => {
      const ctx = createCtx({ isPullRequest: true });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
      expect(mockGovernance.transitionToVoting).not.toHaveBeenCalled();
    });

    it("should reject /vote when already in voting", async () => {
      const ctx = createCtx({
        issueLabels: [{ name: LABELS.VOTING }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should reject /vote when already ready to implement", async () => {
      const ctx = createCtx({
        issueLabels: [{ name: LABELS.READY_TO_IMPLEMENT }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should reject /vote when not in discussion phase", async () => {
      const ctx = createCtx({
        issueLabels: [],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should add confused reaction and error comment on rejection", async () => {
      const ctx = createCtx({
        issueLabels: [{ name: LABELS.VOTING }],
      });
      await executeCommand(ctx);

      const reactionCalls = ctx.octokit.rest.reactions.createForIssueComment.mock.calls;
      // eyes + confused
      expect(reactionCalls).toHaveLength(2);
      expect(reactionCalls[1][0].content).toBe("confused");

      // Error reply
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });
  });

  describe("/implement command", () => {
    it("should transition from discussion to ready-to-implement", async () => {
      const ctx = createCtx({ verb: "implement" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "executed", message: "Fast-tracked to ready-to-implement." });
      expect(mockIssueOps.transition).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "test-org", repo: "test-repo", issueNumber: 42 }),
        expect.objectContaining({
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.READY_TO_IMPLEMENT,
          unlock: true,
        }),
      );
    });

    it("should transition from voting to ready-to-implement", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [{ name: LABELS.VOTING }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
      expect(mockIssueOps.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          removeLabel: LABELS.VOTING,
          addLabel: LABELS.READY_TO_IMPLEMENT,
        }),
      );
    });

    it("should transition from extended-voting to ready-to-implement", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [{ name: LABELS.EXTENDED_VOTING }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
      expect(mockIssueOps.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          removeLabel: LABELS.EXTENDED_VOTING,
          addLabel: LABELS.READY_TO_IMPLEMENT,
        }),
      );
    });

    it("should transition from needs-human to ready-to-implement", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [{ name: LABELS.NEEDS_HUMAN }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
      expect(mockIssueOps.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          removeLabel: LABELS.NEEDS_HUMAN,
          addLabel: LABELS.READY_TO_IMPLEMENT,
        }),
      );
    });

    it("should include sender username and signature in transition comment", async () => {
      const ctx = createCtx({ verb: "implement", senderLogin: "alice" });
      await executeCommand(ctx);

      const transitionCall = mockIssueOps.transition.mock.calls[0];
      const comment = transitionCall[1].comment;
      expect(comment).toContain("@alice");
      expect(comment).toContain("/implement");
      expect(comment).toContain("Hivemoot Queen");
    });

    it("should reject /implement on a PR", async () => {
      const ctx = createCtx({ verb: "implement", isPullRequest: true });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should reject /implement when already ready to implement", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [{ name: LABELS.READY_TO_IMPLEMENT }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should reject /implement when rejected", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [{ name: LABELS.REJECTED }],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });

    it("should reject /implement when no recognized phase label exists", async () => {
      const ctx = createCtx({
        verb: "implement",
        issueLabels: [],
      });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("rejected");
    });
  });

  describe("/doctor command", () => {
    it("should run the full doctor checklist and post a report", async () => {
      const ctx = createCtx({ verb: "doctor" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({
        status: "executed",
        message: "Doctor report posted.",
      });
      expect(mockLabelService.ensureRequiredLabels).toHaveBeenCalledWith("test-org", "test-repo");
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("Doctor Report");
      expect(commentArgs.body).toContain("**Labels**");
      expect(commentArgs.body).toContain(
        `${REQUIRED_REPOSITORY_LABELS.length}/${REQUIRED_REPOSITORY_LABELS.length} labels accounted for`,
      );
      expect(commentArgs.body).toContain("Renamed `phase:voting` -> `hivemoot:voting`");
      expect(commentArgs.body).toContain("**Config**");
      expect(commentArgs.body).toContain("Loaded `.github/hivemoot.yml`");
      expect(commentArgs.body).toContain("**PR Workflow**");
      expect(commentArgs.body).toContain("**Standup**: Disabled");
      expect(commentArgs.body).toContain("**Permissions**");
      expect(commentArgs.body).toContain("**LLM**");
      expect(commentArgs.body).toContain(`${REQUIRED_REPOSITORY_LABELS.length}`);
      expect(commentArgs.body).toContain("checks passed");
    });

    it("should report when no legacy labels were renamed", async () => {
      mockLabelService.ensureRequiredLabels.mockResolvedValueOnce({
        created: 0,
        renamed: 0,
        updated: 0,
        skipped: REQUIRED_REPOSITORY_LABELS.length,
        renamedLabels: [],
      });

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("No legacy labels were renamed");
    });

    it("should fail PR workflow check when approval is enabled without trusted reviewers", async () => {
      const { loadRepositoryConfig } = await import("../index.js");
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce({
        version: 1,
        governance: {
          proposals: {
            discussion: { exits: [{ type: "manual" }], durationMs: 0 },
            voting: { exits: [{ type: "manual" }], durationMs: 0 },
            extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
          },
          pr: {
            staleDays: 3,
            maxPRsPerIssue: 3,
            trustedReviewers: [],
            intake: [{ method: "approval", minApprovals: 2 }],
            mergeReady: null,
          },
        },
        standup: {
          enabled: false,
          category: "",
        },
      });

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);
      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**PR Workflow**");
      expect(commentArgs.body).toContain("trustedReviewers` is empty");
    });

    it("should report permission probe failures with details", async () => {
      const octokit = createMockOctokit();
      octokit.rest.pulls.list.mockRejectedValueOnce(new Error("Forbidden"));

      const ctx = createCtx({ verb: "doctor", octokit });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**Permissions**: 1/3 capability probes failed");
      expect(commentArgs.body).toContain("pull_requests: Forbidden");
    });

    it("should show LLM pass when provider and key are configured", async () => {
      const { getLLMReadiness } = await import("../llm/provider.js");
      vi.mocked(getLLMReadiness).mockReturnValueOnce({ ready: true });

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**LLM**: Provider, model, and API key are configured");
    });

    it("should show LLM fail when api key is missing", async () => {
      const { getLLMReadiness } = await import("../llm/provider.js");
      vi.mocked(getLLMReadiness).mockReturnValueOnce({
        ready: false,
        reason: "api_key_missing",
      });

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**LLM**: Provider/model configured but API key is missing");
    });

    it("should continue report generation when a check throws unexpectedly", async () => {
      mockLabelService.ensureRequiredLabels.mockRejectedValueOnce(new Error("boom"));

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**Labels**: Check failed: boom");
      expect(commentArgs.body).toContain("**Config**");
    });

    it("should report advisory PR workflow and validate enabled standup category", async () => {
      const { loadRepositoryConfig } = await import("../index.js");
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce({
        version: 1,
        governance: {
          proposals: {
            discussion: { exits: [{ type: "manual" }], durationMs: 0 },
            voting: { exits: [{ type: "manual" }], durationMs: 0 },
            extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
          },
          pr: {
            staleDays: 3,
            maxPRsPerIssue: 3,
            trustedReviewers: [],
            intake: [{ method: "update" }],
            mergeReady: null,
          },
        },
        standup: {
          enabled: true,
          category: "Hivemoot Reports",
        },
      });

      const ctx = createCtx({ verb: "doctor" });
      await executeCommand(ctx);

      const [commentArgs] = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(commentArgs.body).toContain("**PR Workflow**: No trusted reviewers configured");
      expect(commentArgs.body).toContain("**Standup**: Category `Hivemoot Reports` is available");
    });
  });

  describe("/gather command", () => {
    it("should create canonical blueprint comment when none exists", async () => {
      mockIssueOps.getIssueContext.mockResolvedValue({
        title: "Improve onboarding docs",
        body: "Proposal body",
        author: "queen",
        comments: [
          { author: "alice", body: "Looks good", createdAt: "2026-02-16T00:00:00.000Z" },
        ],
      });

      const ctx = createCtx({ verb: "gather" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "executed", message: "Created the blueprint comment." });
      expect(mockIssueOps.findAlignmentCommentId).toHaveBeenCalledWith(expect.objectContaining({
        owner: "test-org",
        repo: "test-repo",
        issueNumber: 42,
      }));
      expect(mockIssueOps.comment).toHaveBeenCalledTimes(1);
      const body = mockIssueOps.comment.mock.calls[0][1];
      expect(body).toContain('"type":"alignment"');
      expect(body).toContain("Blueprint");
      expect(body).toContain("@maintainer via `/gather`");
    });

    it("should use LLM-generated blueprint when generation succeeds", async () => {
      mockIssueOps.getIssueContext.mockResolvedValue({
        title: "Improve onboarding docs",
        body: "Proposal body",
        author: "queen",
        comments: [
          { author: "alice", body: "Looks good", createdAt: "2026-02-16T00:00:00.000Z" },
        ],
      });
      mockBlueprintGenerate.mockResolvedValue({
        success: true,
        plan: {
          goal: "Revamp the onboarding documentation",
          plan: "1. Audit existing docs\n2. Add getting started guide",
          decisions: ["Use MDX format"],
          outOfScope: ["Video tutorials"],
          openQuestions: [],
          metadata: { commentCount: 1, participantCount: 1 },
        },
      });

      const ctx = createCtx({ verb: "gather" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "executed", message: "Created the blueprint comment." });
      const body = mockIssueOps.comment.mock.calls[0][1];
      expect(body).toContain("Revamp the onboarding documentation");
      expect(body).toContain("## Plan");
      expect(body).toContain("## Decisions");
      expect(body).toContain("Use MDX format");
      expect(body).toContain("## Out of scope");
      expect(body).toContain("Video tutorials");
    });

    it("should log reason when using fallback blueprint", async () => {
      mockIssueOps.getIssueContext.mockResolvedValue({
        title: "Test",
        body: "Body",
        author: "queen",
        comments: [
          { author: "alice", body: "Comment", createdAt: "2026-02-16T00:00:00.000Z" },
        ],
      });
      mockBlueprintGenerate.mockResolvedValue({
        success: false,
        reason: "LLM not configured",
      });

      const ctx = createCtx({ verb: "gather" });
      await executeCommand(ctx);

      expect(ctx.log.warn).toHaveBeenCalledWith(
        "Using fallback blueprint for #42: LLM not configured"
      );
    });

    it("should update existing canonical blueprint comment", async () => {
      mockIssueOps.findAlignmentCommentId.mockResolvedValue(555);
      mockIssueOps.getIssueContext.mockResolvedValue({
        title: "Improve onboarding docs",
        body: "Proposal body",
        author: "queen",
        comments: [],
      });

      const ctx = createCtx({ verb: "gather" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "executed", message: "Updated the blueprint comment." });
      expect(ctx.octokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        comment_id: 555,
        body: expect.stringContaining('"type":"alignment"'),
      });
      expect(mockIssueOps.comment).not.toHaveBeenCalled();
    });

    it("should reject /gather on pull requests", async () => {
      const ctx = createCtx({ verb: "gather", isPullRequest: true });
      const result = await executeCommand(ctx);
      expect(result.status).toBe("rejected");
    });

    it("should reject /gather when issue is not in discussion phase", async () => {
      const ctx = createCtx({
        verb: "gather",
        issueLabels: [{ name: LABELS.VOTING }],
      });
      const result = await executeCommand(ctx);
      expect(result.status).toBe("rejected");
    });

    it("should preserve existing blueprint when refresh context fetch fails", async () => {
      mockIssueOps.findAlignmentCommentId.mockResolvedValue(555);
      mockIssueOps.getIssueContext.mockRejectedValue(new Error("upstream timeout"));

      const ctx = createCtx({ verb: "gather" });
      const result = await executeCommand(ctx);

      expect(result).toEqual({
        status: "executed",
        message: "Blueprint refresh failed; previous comment preserved.",
      });
      expect(ctx.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Keeping the previous blueprint comment unchanged."),
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should add confused reaction, post a generic failure reply, and re-throw on handler error", async () => {
      mockGovernance.transitionToVoting.mockRejectedValue(new Error("API error"));
      const ctx = createCtx();

      await expect(executeCommand(ctx)).rejects.toThrow("API error");

      const reactionCalls = ctx.octokit.rest.reactions.createForIssueComment.mock.calls;
      expect(reactionCalls.some((c: unknown[]) => (c[0] as { content: string }).content === "confused")).toBe(true);
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("CMD_VOTE_UNEXPECTED"),
        }),
      );
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("cmd-2s"),
        }),
      );
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: "CMD_VOTE_UNEXPECTED",
          correlationId: "cmd-2s",
          command: "vote",
          senderPermission: "admin",
        }),
        expect.stringContaining("Command /vote failed"),
      );
    });

    it("should classify retryable API failures as transient in fallback reply", async () => {
      const transientError = Object.assign(new Error("Service unavailable"), { status: 503 });
      mockGovernance.transitionToVoting.mockRejectedValue(transientError);
      const ctx = createCtx();

      await expect(executeCommand(ctx)).rejects.toThrow("Service unavailable");

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("CMD_VOTE_TRANSIENT"),
        }),
      );
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("This looks transient"),
        }),
      );
    });

    it("should classify 403 failures as permission issues in fallback reply", async () => {
      const permissionError = Object.assign(new Error("Forbidden"), { status: 403 });
      mockGovernance.transitionToVoting.mockRejectedValue(permissionError);
      const ctx = createCtx();

      await expect(executeCommand(ctx)).rejects.toThrow("Forbidden");

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("CMD_VOTE_PERMISSION"),
        }),
      );
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Check repository/app permissions"),
        }),
      );
    });

    it("should classify 422 failures as validation issues in fallback reply", async () => {
      const validationError = Object.assign(new Error("Unprocessable"), { status: 422 });
      mockGovernance.transitionToVoting.mockRejectedValue(validationError);
      const ctx = createCtx();

      await expect(executeCommand(ctx)).rejects.toThrow("Unprocessable");

      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("CMD_VOTE_VALIDATION"),
        }),
      );
      expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Verify repository configuration and pull request state"),
        }),
      );
    });

    it("should not fail if acknowledgment reaction throws", async () => {
      const octokit = createMockOctokit();
      octokit.rest.reactions.createForIssueComment
        .mockRejectedValueOnce(new Error("Reaction failed"))
        .mockResolvedValue({});

      const ctx = createCtx({ octokit });
      // Should still execute successfully despite reaction failure
      const result = await executeCommand(ctx);
      expect(result.status).toBe("executed");
    });

    it("should log when reaction fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.reactions.createForIssueComment
        .mockRejectedValueOnce(new Error("Reaction failed"))
        .mockResolvedValue({});

      const ctx = createCtx({ octokit });
      await executeCommand(ctx);

      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ content: "eyes" }),
        expect.stringContaining("Failed to add eyes reaction"),
      );
    });

    it("should not crash when rejection reply fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.issues.createComment.mockRejectedValue(new Error("Rate limited"));

      const ctx = createCtx({
        octokit,
        issueLabels: [{ name: LABELS.VOTING }],
      });
      // Should complete without throwing even though reply() fails
      const result = await executeCommand(ctx);
      expect(result.status).toBe("rejected");
    });

    it("should log when rejection reply fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.issues.createComment.mockRejectedValue(new Error("Rate limited"));

      const ctx = createCtx({
        octokit,
        issueLabels: [{ name: LABELS.VOTING }],
      });
      await executeCommand(ctx);

      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ issue: 42 }),
        expect.stringContaining("Failed to post reply comment"),
      );
    });

    it("should log when permission check fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(
        new Error("Token expired"),
      );

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "ignored" });
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ user: "maintainer" }),
        expect.stringContaining("Permission check failed"),
      );
    });
  });

  describe("legacy label support", () => {
    it("should recognize legacy label names via isLabelMatch", async () => {
      const ctx = createCtx({
        issueLabels: [{ name: "phase:discussion" }],
      });
      const result = await executeCommand(ctx);
      expect(result.status).toBe("executed");
    });
  });

  describe("idempotency guard", () => {
    it("should skip execution when bot already reacted with eyes", async () => {
      const octokit = createMockOctokit();
      // Mock that this app authored a comment - so we can resolve bot login
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            user: { login: "hivemoot[bot]" },
            performed_via_github_app: { id: 12345, name: "Hivemoot" },
          },
        ],
      });
      // Mock eyes reaction from our bot
      octokit.rest.reactions.listForIssueComment.mockResolvedValue({
        data: [{ user: { login: "hivemoot[bot]" } }],
      });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "ignored" });
      expect(mockGovernance.transitionToVoting).not.toHaveBeenCalled();
      expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
    });

    it("should paginate issue comments to resolve app bot login on later pages", async () => {
      const octokit = createMockOctokit();
      octokit.rest.issues.listComments
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, i) => ({
            user: { login: `human-${i}` },
            performed_via_github_app: { id: 99999, name: "Other App" },
          })),
        })
        .mockResolvedValueOnce({
          data: [
            {
              user: { login: "hivemoot[bot]" },
              performed_via_github_app: { id: 12345, name: "Hivemoot" },
            },
          ],
        });
      octokit.rest.reactions.listForIssueComment.mockResolvedValue({
        data: [{ user: { login: "hivemoot[bot]" } }],
      });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "ignored" });
      expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
      expect(octokit.rest.issues.listComments).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ per_page: 100, page: 1 }),
      );
      expect(octokit.rest.issues.listComments).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ per_page: 100, page: 2 }),
      );
    });

    it("should not skip when eyes reaction is from a different bot", async () => {
      const octokit = createMockOctokit();
      // Mock that this app authored a comment
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            user: { login: "hivemoot[bot]" },
            performed_via_github_app: { id: 12345, name: "Hivemoot" },
          },
        ],
      });
      // Mock eyes reaction from a different bot
      octokit.rest.reactions.listForIssueComment.mockResolvedValue({
        data: [{ user: { login: "codecov[bot]" } }],
      });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
    });

    it("should proceed when bot identity cannot be resolved", async () => {
      const octokit = createMockOctokit();
      // Mock that we cannot resolve bot login (no comments from this app)
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            user: { login: "other-bot[bot]" },
            performed_via_github_app: { id: 99999, name: "Other App" },
          },
        ],
      });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      // Should proceed because we can't confirm bot identity - fail open
      expect(result.status).toBe("executed");
    });

    it("should proceed when reaction check fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.reactions.listForIssueComment.mockRejectedValue(
        new Error("API error"),
      );

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
    });

    it("should proceed when no eyes reactions exist", async () => {
      const octokit = createMockOctokit();
      octokit.rest.reactions.listForIssueComment.mockResolvedValue({
        data: [],
      });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result.status).toBe("executed");
    });

    it("should paginate eyes reactions and skip when bot is found on later page", async () => {
      const octokit = createMockOctokit();
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            user: { login: "hivemoot[bot]" },
            performed_via_github_app: { id: 12345, name: "Hivemoot" },
          },
        ],
      });
      octokit.rest.reactions.listForIssueComment
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, i) => ({ user: { login: `human-${i}` } })),
        })
        .mockResolvedValueOnce({
          data: [{ user: { login: "hivemoot[bot]" } }],
        });

      const ctx = createCtx({ octokit });
      const result = await executeCommand(ctx);

      expect(result).toEqual({ status: "ignored" });
      expect(octokit.rest.reactions.listForIssueComment).toHaveBeenCalledTimes(2);
      expect(octokit.rest.reactions.listForIssueComment).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ per_page: 100, page: 1 }),
      );
      expect(octokit.rest.reactions.listForIssueComment).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ per_page: 100, page: 2 }),
      );
    });
  });

  describe("reply signature", () => {
    it("should append SIGNATURE to rejection replies", async () => {
      const ctx = createCtx({
        issueLabels: [{ name: LABELS.VOTING }],
      });
      await executeCommand(ctx);

      const replyCall = ctx.octokit.rest.issues.createComment.mock.calls[0];
      expect(replyCall[0].body).toContain("Hivemoot Queen");
    });
  });
});
