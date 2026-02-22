import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getLinkedIssues: vi.fn(),
    getOpenPRsForIssue: vi.fn(),
    createIssueOperations: vi.fn(),
    createPROperations: vi.fn(),
    createGovernanceService: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    processImplementationIntake: vi.fn(),
    recalculateLeaderboardForPR: vi.fn(),
    evaluateMergeReadiness: vi.fn(),
    issuesOps: {
      comment: vi.fn(),
      addLabels: vi.fn(),
      removeLabel: vi.fn(),
      close: vi.fn(),
    },
    prOps: {
      comment: vi.fn(),
      close: vi.fn(),
      removeGovernanceLabels: vi.fn(),
      removeLabel: vi.fn(),
    },
    governanceService: {
      startDiscussion: vi.fn(),
    },
  };
});

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

const envMocks = vi.hoisted(() => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

vi.mock("../../lib/env-validation.js", () => envMocks);

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: mocks.getLinkedIssues,
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: mocks.createIssueOperations,
  createPROperations: mocks.createPROperations,
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: mocks.createGovernanceService,
  loadRepositoryConfig: mocks.loadRepositoryConfig,
  getOpenPRsForIssue: mocks.getOpenPRsForIssue,
  evaluateMergeReadiness: mocks.evaluateMergeReadiness,
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: mocks.processImplementationIntake,
  recalculateLeaderboardForPR: mocks.recalculateLeaderboardForPR,
}));

import { LABELS } from "../../config.js";
import { app as registerWebhookApp } from "./index.js";

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const entry of event) {
          handlers.set(entry, handler);
        }
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

const defaultRepoConfig = {
  governance: {
    proposals: {
      discussion: { exits: [{ type: "manual" }] },
    },
    pr: {
      maxPRsPerIssue: 3,
      trustedReviewers: [],
      intake: {},
      mergeReady: { minApprovals: 1 },
      staleDays: 3,
    },
  },
};

function createBaseContext(overrides?: Record<string, unknown>) {
  return {
    octokit: {},
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    payload: {
      repository: {
        owner: { login: "hivemoot" },
        name: "test-repo",
        full_name: "hivemoot/test-repo",
      },
      ...overrides,
    },
  };
}

describe("webhook handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.getAppId.mockReturnValue(12345);
    mocks.createIssueOperations.mockReturnValue(mocks.issuesOps);
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.createGovernanceService.mockReturnValue(mocks.governanceService);
    mocks.loadRepositoryConfig.mockResolvedValue(defaultRepoConfig);
    mocks.getLinkedIssues.mockResolvedValue([]);
    mocks.getOpenPRsForIssue.mockResolvedValue([]);
    mocks.processImplementationIntake.mockResolvedValue(undefined);
    mocks.recalculateLeaderboardForPR.mockResolvedValue(undefined);
    mocks.evaluateMergeReadiness.mockResolvedValue(undefined);
    mocks.governanceService.startDiscussion.mockResolvedValue(undefined);
    mocks.issuesOps.comment.mockResolvedValue(undefined);
    mocks.issuesOps.addLabels.mockResolvedValue(undefined);
    mocks.issuesOps.removeLabel.mockResolvedValue(undefined);
    mocks.issuesOps.close.mockResolvedValue(undefined);
    mocks.prOps.comment.mockResolvedValue(undefined);
    mocks.prOps.close.mockResolvedValue(undefined);
    mocks.prOps.removeGovernanceLabels.mockResolvedValue(undefined);
    mocks.prOps.removeLabel.mockResolvedValue(undefined);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request.closed
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request.closed", () => {
    it("should clean governance labels and recalculate leaderboard when PR closed without merge", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      await handler(createBaseContext({
        pull_request: { number: 10, merged: false },
      }));

      expect(mocks.prOps.removeGovernanceLabels).toHaveBeenCalledWith({
        owner: "hivemoot", repo: "test-repo", prNumber: 10,
      });
      expect(mocks.recalculateLeaderboardForPR).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "hivemoot", "test-repo", 10,
      );
      // Should NOT attempt merged-PR logic
      expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
      expect(mocks.issuesOps.close).not.toHaveBeenCalled();
    });

    it("should transition linked ready-to-implement issues to implemented when PR merged", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      const linkedIssue = {
        number: 5,
        title: "Feature request",
        state: "OPEN",
        labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      };
      mocks.getLinkedIssues.mockResolvedValue([linkedIssue]);
      mocks.getOpenPRsForIssue.mockResolvedValue([]);

      await handler(createBaseContext({
        pull_request: { number: 10, merged: true },
      }));

      const issueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 5 };
      expect(mocks.issuesOps.removeLabel).toHaveBeenCalledWith(issueRef, LABELS.READY_TO_IMPLEMENT);
      expect(mocks.issuesOps.addLabels).toHaveBeenCalledWith(issueRef, [LABELS.IMPLEMENTED]);
      expect(mocks.issuesOps.close).toHaveBeenCalledWith(issueRef, "completed");
      expect(mocks.issuesOps.comment).toHaveBeenCalledWith(
        issueRef, expect.stringContaining("#10"),
      );
    });

    it("should close competing PRs when merged PR has linked issues", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      const linkedIssue = {
        number: 5,
        title: "Feature",
        state: "OPEN",
        labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      };
      mocks.getLinkedIssues.mockResolvedValue([linkedIssue]);
      mocks.getOpenPRsForIssue.mockResolvedValue([
        { number: 10 }, // the merged PR itself
        { number: 11 }, // competing PR
        { number: 12 }, // another competing PR
      ]);

      await handler(createBaseContext({
        pull_request: { number: 10, merged: true },
      }));

      // Competing PRs should be closed with superseded comment
      expect(mocks.prOps.comment).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", prNumber: 11 },
        expect.stringContaining("#10"),
      );
      expect(mocks.prOps.close).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", prNumber: 11 },
      );
      expect(mocks.prOps.close).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", prNumber: 12 },
      );
      // The merged PR itself should NOT be closed
      expect(mocks.prOps.close).not.toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 10 }),
      );
    });

    it("should skip issues without ready-to-implement label on merge", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      const linkedIssue = {
        number: 5,
        title: "Discussion issue",
        state: "OPEN",
        labels: { nodes: [{ name: LABELS.DISCUSSION }] },
      };
      mocks.getLinkedIssues.mockResolvedValue([linkedIssue]);

      await handler(createBaseContext({
        pull_request: { number: 10, merged: true },
      }));

      expect(mocks.issuesOps.close).not.toHaveBeenCalled();
      expect(mocks.issuesOps.addLabels).not.toHaveBeenCalled();
    });

    it("should remove governance labels from merged PR", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      mocks.getLinkedIssues.mockResolvedValue([]);

      await handler(createBaseContext({
        pull_request: { number: 10, merged: true },
      }));

      expect(mocks.prOps.removeGovernanceLabels).toHaveBeenCalledWith({
        owner: "hivemoot", repo: "test-repo", prNumber: 10,
      });
    });

    it("should propagate errors from merged PR processing", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed")!;

      mocks.getLinkedIssues.mockRejectedValue(new Error("GraphQL timeout"));

      await expect(handler(createBaseContext({
        pull_request: { number: 10, merged: true },
      }))).rejects.toThrow("GraphQL timeout");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // issue_comment.created
  // ─────────────────────────────────────────────────────────────────────────

  describe("issue_comment.created", () => {
    it("should skip non-PR comments (plain issue comments)", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;

      await handler(createBaseContext({
        issue: { number: 5, pull_request: undefined },
        comment: { performed_via_github_app: null },
      }));

      expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should skip comments from the bot itself (app ID check)", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;

      await handler(createBaseContext({
        issue: { number: 5, pull_request: { url: "..." } },
        comment: { performed_via_github_app: { id: 12345 } },
      }));

      expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should process intake for external PR comments", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;

      await handler(createBaseContext({
        issue: { number: 7, pull_request: { url: "..." } },
        comment: { performed_via_github_app: null },
      }));

      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          prNumber: 7,
          trigger: "updated",
        }),
      );
    });

    it("should process intake for comments from other GitHub Apps", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;

      await handler(createBaseContext({
        issue: { number: 7, pull_request: { url: "..." } },
        comment: { performed_via_github_app: { id: 99999 } },
      }));

      expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
    });

    it("should propagate errors from intake processing", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;

      mocks.processImplementationIntake.mockRejectedValue(new Error("intake failed"));

      await expect(handler(createBaseContext({
        issue: { number: 7, pull_request: { url: "..." } },
        comment: { performed_via_github_app: null },
      }))).rejects.toThrow("intake failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request_review.submitted
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request_review.submitted", () => {
    it("should recalculate leaderboard and run intake on approval", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted")!;

      await handler(createBaseContext({
        pull_request: { number: 15 },
        review: { state: "approved" },
      }));

      expect(mocks.recalculateLeaderboardForPR).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "hivemoot", "test-repo", 15,
      );
      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 15,
          trigger: "updated",
        }),
      );
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 15 },
        }),
      );
    });

    it("should skip leaderboard recalc and intake on non-approval reviews", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted")!;

      await handler(createBaseContext({
        pull_request: { number: 15 },
        review: { state: "changes_requested" },
      }));

      expect(mocks.recalculateLeaderboardForPR).not.toHaveBeenCalled();
      expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
      // Merge-readiness should still be evaluated for all review states
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(1);
    });

    it("should evaluate merge-readiness for comment reviews", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted")!;

      await handler(createBaseContext({
        pull_request: { number: 15 },
        review: { state: "commented" },
      }));

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(1);
    });

    it("should propagate errors", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted")!;

      mocks.evaluateMergeReadiness.mockRejectedValue(new Error("readiness check failed"));

      await expect(handler(createBaseContext({
        pull_request: { number: 15 },
        review: { state: "approved" },
      }))).rejects.toThrow("readiness check failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request_review.dismissed
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request_review.dismissed", () => {
    it("should recalculate leaderboard and re-evaluate merge-readiness", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.dismissed")!;

      await handler(createBaseContext({
        pull_request: { number: 20 },
      }));

      expect(mocks.recalculateLeaderboardForPR).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "hivemoot", "test-repo", 20,
      );
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 20 },
        }),
      );
    });

    it("should propagate errors from leaderboard recalculation", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.dismissed")!;

      mocks.recalculateLeaderboardForPR.mockRejectedValue(new Error("recalc failed"));

      await expect(handler(createBaseContext({
        pull_request: { number: 20 },
      }))).rejects.toThrow("recalc failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // issues.opened
  // ─────────────────────────────────────────────────────────────────────────

  describe("issues.opened", () => {
    it("should start discussion with manual welcome when discussion exits are manual", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;

      mocks.loadRepositoryConfig.mockResolvedValue({
        governance: {
          proposals: {
            discussion: { exits: [{ type: "manual" }] },
          },
          pr: defaultRepoConfig.governance.pr,
        },
      });

      await handler(createBaseContext({
        issue: { number: 42 },
      }));

      expect(mocks.governanceService.startDiscussion).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", issueNumber: 42 },
        expect.stringContaining("Nothing moves forward automatically"),
      );
    });

    it("should start discussion with voting welcome when discussion exits are auto", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;

      mocks.loadRepositoryConfig.mockResolvedValue({
        governance: {
          proposals: {
            discussion: { exits: [{ type: "auto", afterMinutes: 1440 }] },
          },
          pr: defaultRepoConfig.governance.pr,
        },
      });

      await handler(createBaseContext({
        issue: { number: 42 },
      }));

      expect(mocks.governanceService.startDiscussion).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", issueNumber: 42 },
        expect.stringContaining("Ready to vote?"),
      );
    });

    it("should propagate errors from governance service", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;

      mocks.governanceService.startDiscussion.mockRejectedValue(new Error("API error"));

      await expect(handler(createBaseContext({
        issue: { number: 42 },
      }))).rejects.toThrow("API error");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request.synchronize
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request.synchronize", () => {
    it("should remove merge-ready label and process intake on new commits", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.synchronize")!;

      await handler(createBaseContext({
        pull_request: { number: 30 },
      }));

      expect(mocks.prOps.removeLabel).toHaveBeenCalledWith(
        { owner: "hivemoot", repo: "test-repo", prNumber: 30 },
        LABELS.MERGE_READY,
      );
      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 30,
          trigger: "updated",
        }),
      );
    });

    it("should propagate errors", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.synchronize")!;

      mocks.prOps.removeLabel.mockRejectedValue(new Error("label removal failed"));

      await expect(handler(createBaseContext({
        pull_request: { number: 30 },
      }))).rejects.toThrow("label removal failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request.edited
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request.edited", () => {
    it("should skip non-body edits", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.edited")!;

      await handler(createBaseContext({
        pull_request: { number: 35, updated_at: "2026-01-01T00:00:00Z" },
        changes: { title: { from: "old title" } },
      }));

      expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should process intake on body edits with editedAt timestamp", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.edited")!;

      await handler(createBaseContext({
        pull_request: { number: 35, updated_at: "2026-01-15T12:00:00Z" },
        changes: { body: { from: "old body" } },
      }));

      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 35,
          trigger: "edited",
          editedAt: new Date("2026-01-15T12:00:00Z"),
        }),
      );
    });

    it("should skip when changes object has no body field", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.edited")!;

      await handler(createBaseContext({
        pull_request: { number: 35, updated_at: "2026-01-01T00:00:00Z" },
        changes: {},
      }));

      expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // check_suite.completed
  // ─────────────────────────────────────────────────────────────────────────

  describe("check_suite.completed", () => {
    it("should skip when no pull_requests in payload", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_suite.completed")!;

      await handler(createBaseContext({
        check_suite: { pull_requests: [], head_sha: "abc123" },
      }));

      expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should evaluate merge-readiness for each associated PR", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_suite.completed")!;

      await handler(createBaseContext({
        check_suite: {
          pull_requests: [{ number: 40 }, { number: 41 }],
          head_sha: "abc123",
        },
      }));

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(2);
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 40 },
          headSha: "abc123",
        }),
      );
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 41 },
          headSha: "abc123",
        }),
      );
    });

    it("should aggregate errors from multiple PR evaluations", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_suite.completed")!;

      mocks.evaluateMergeReadiness
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("PR 41 failed"));

      await expect(handler(createBaseContext({
        check_suite: {
          pull_requests: [{ number: 40 }, { number: 41 }],
          head_sha: "abc123",
        },
      }))).rejects.toThrow("1 PR(s) failed merge-readiness evaluation");
    });

    it("should skip when pull_requests is null", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_suite.completed")!;

      await handler(createBaseContext({
        check_suite: { pull_requests: null, head_sha: "abc123" },
      }));

      expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // check_run.completed
  // ─────────────────────────────────────────────────────────────────────────

  describe("check_run.completed", () => {
    it("should skip when no pull_requests in payload", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_run.completed")!;

      await handler(createBaseContext({
        check_run: { pull_requests: [], head_sha: "def456" },
      }));

      expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should evaluate merge-readiness for associated PRs", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("check_run.completed")!;

      await handler(createBaseContext({
        check_run: {
          pull_requests: [{ number: 50 }],
          head_sha: "def456",
        },
      }));

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 50 },
          headSha: "def456",
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pull_request.labeled / pull_request.unlabeled
  // ─────────────────────────────────────────────────────────────────────────

  describe("pull_request.labeled / pull_request.unlabeled", () => {
    it("should skip when label is not implementation", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.labeled")!;

      await handler(createBaseContext({
        pull_request: { number: 60, labels: [] },
        label: { name: "bug" },
      }));

      expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should evaluate merge-readiness when implementation label is added", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.labeled")!;

      await handler(createBaseContext({
        pull_request: {
          number: 60,
          labels: [{ name: LABELS.IMPLEMENTATION }],
        },
        label: { name: LABELS.IMPLEMENTATION },
      }));

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 60 },
          currentLabels: [LABELS.IMPLEMENTATION],
        }),
      );
    });

    it("should evaluate merge-readiness when implementation label is removed", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.unlabeled")!;

      await handler(createBaseContext({
        pull_request: { number: 60, labels: [] },
        label: { name: LABELS.IMPLEMENTATION },
      }));

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 60 },
          currentLabels: [],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // status
  // ─────────────────────────────────────────────────────────────────────────

  describe("status", () => {
    it("should skip when mergeReady config is not set", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("status")!;

      mocks.loadRepositoryConfig.mockResolvedValue({
        governance: { pr: { mergeReady: null } },
      });

      const context = createBaseContext({ sha: "abc123" });
      (context.octokit as any).rest = {
        pulls: { list: vi.fn() },
      };

      await handler(context);

      expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should find matching PRs by SHA and evaluate merge-readiness", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("status")!;

      const context = createBaseContext({ sha: "sha-xyz" });
      (context.octokit as any).rest = {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [
              { number: 70, head: { sha: "sha-xyz" } },
              { number: 71, head: { sha: "other-sha" } },
            ],
          }),
        },
      };

      await handler(context);

      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(1);
      expect(mocks.evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 70 },
          headSha: "sha-xyz",
        }),
      );
    });

    it("should aggregate errors from multiple PR evaluations", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("status")!;

      const context = createBaseContext({ sha: "sha-xyz" });
      (context.octokit as any).rest = {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [
              { number: 70, head: { sha: "sha-xyz" } },
              { number: 71, head: { sha: "sha-xyz" } },
            ],
          }),
        },
      };

      mocks.evaluateMergeReadiness
        .mockRejectedValueOnce(new Error("PR 70 failed"))
        .mockRejectedValueOnce(new Error("PR 71 failed"));

      await expect(handler(context)).rejects.toThrow(
        "2 PR(s) failed merge-readiness evaluation",
      );
    });
  });
});
