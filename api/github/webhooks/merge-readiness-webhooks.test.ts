import { describe, it, expect, vi, beforeEach } from "vitest";
import { app as registerWebhookApp } from "./index.js";

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

vi.mock("../../lib/llm/provider.js", () => ({
  getLLMReadiness: vi.fn(() => ({ ready: true })),
}));

vi.mock("../../lib/commands/index.js", () => ({
  parseCommand: vi.fn(() => null),
  executeCommand: vi.fn(),
}));

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: vi.fn(async () => []),
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: vi.fn(async () => {}),
  recalculateLeaderboardForPR: vi.fn(async () => {}),
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: vi.fn(() => ({})),
  createPROperations: vi.fn(() => ({})),
  createRepositoryLabelService: vi.fn(() => ({
    ensureRequiredLabels: vi.fn(async () => ({ created: 0, renamed: 0, updated: 0, skipped: 0 })),
  })),
  createGovernanceService: vi.fn(() => ({
    startDiscussion: vi.fn(async () => {}),
    postVotingComment: vi.fn(async () => "posted"),
  })),
  loadRepositoryConfig: vi.fn(async () => ({
    governance: {
      pr: {
        maxPRsPerIssue: 3,
        trustedReviewers: [],
        intake: { enabled: true },
        mergeReady: { enabled: true },
      },
    },
  })),
  getOpenPRsForIssue: vi.fn(async () => []),
  evaluateMergeReadiness: vi.fn(async () => {}),
}));

import {
  createPROperations,
  loadRepositoryConfig,
  evaluateMergeReadiness,
} from "../../lib/index.js";
import {
  processImplementationIntake,
  recalculateLeaderboardForPR,
} from "../../lib/implementation-intake.js";

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const entry of event) handlers.set(entry, handler);
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

function createWebhookContext(overrides?: {
  payload?: Record<string, unknown>;
  octokit?: Record<string, unknown>;
}) {
  const octokit = overrides?.octokit ?? {
    rest: {
      pulls: {
        list: vi.fn(async () => ({
          data: [
            { number: 11, head: { sha: "match-sha" } },
            { number: 12, head: { sha: "other-sha" } },
          ],
        })),
      },
    },
  };
  const payload = overrides?.payload ?? {};
  return {
    octokit,
    payload,
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
}

describe("merge-readiness webhook handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs intake + leaderboard + merge-readiness on review approval", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request_review.submitted");
    expect(handler).toBeDefined();

    const context = createWebhookContext({
      payload: {
        review: { state: "approved" },
        pull_request: { number: 42 },
        repository: { name: "repo", full_name: "hivemoot/repo", owner: { login: "hivemoot" } },
      },
    });

    await handler!(context);

    expect(recalculateLeaderboardForPR).toHaveBeenCalledWith(
      context.octokit,
      context.log,
      "hivemoot",
      "repo",
      42
    );
    expect(processImplementationIntake).toHaveBeenCalledTimes(1);
    expect(processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "hivemoot",
        repo: "repo",
        prNumber: 42,
        trigger: "updated",
      })
    );
    expect(evaluateMergeReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateMergeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "repo", prNumber: 42 },
      })
    );
  });

  it("skips intake and leaderboard on non-approval reviews", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request_review.submitted");
    expect(handler).toBeDefined();

    const context = createWebhookContext({
      payload: {
        review: { state: "commented" },
        pull_request: { number: 55 },
        repository: { name: "repo", full_name: "hivemoot/repo", owner: { login: "hivemoot" } },
      },
    });

    await handler!(context);

    expect(recalculateLeaderboardForPR).not.toHaveBeenCalled();
    expect(processImplementationIntake).not.toHaveBeenCalled();
    expect(evaluateMergeReadiness).toHaveBeenCalledTimes(1);
  });

  it("evaluates merge-readiness for each PR in check_run completion payload", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("check_run.completed");
    expect(handler).toBeDefined();

    const context = createWebhookContext({
      payload: {
        check_run: {
          head_sha: "abc123",
          pull_requests: [{ number: 5 }, { number: 7 }],
        },
        repository: { name: "repo", full_name: "hivemoot/repo", owner: { login: "hivemoot" } },
      },
    });

    await handler!(context);

    expect(loadRepositoryConfig).toHaveBeenCalledWith(context.octokit, "hivemoot", "repo");
    expect(evaluateMergeReadiness).toHaveBeenCalledTimes(2);
    expect(evaluateMergeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "repo", prNumber: 5 },
        headSha: "abc123",
      })
    );
    expect(evaluateMergeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "repo", prNumber: 7 },
        headSha: "abc123",
      })
    );
  });

  it("filters status events to matching PR head SHAs", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    const context = createWebhookContext({
      payload: {
        sha: "match-sha",
        repository: { name: "repo", full_name: "hivemoot/repo", owner: { login: "hivemoot" } },
      },
    });

    await handler!(context);

    expect((context.octokit as any).rest.pulls.list).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "repo",
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    expect(evaluateMergeReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateMergeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "repo", prNumber: 11 },
        headSha: "match-sha",
      })
    );
  });

  it("returns early for label changes that are not implementation label", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.labeled");
    expect(handler).toBeDefined();

    const context = createWebhookContext({
      payload: {
        label: { name: "documentation" },
        pull_request: { number: 88, labels: [{ name: "documentation" }] },
        repository: { name: "repo", full_name: "hivemoot/repo", owner: { login: "hivemoot" } },
      },
    });

    await handler!(context);

    expect(createPROperations).not.toHaveBeenCalled();
    expect(loadRepositoryConfig).not.toHaveBeenCalled();
    expect(evaluateMergeReadiness).not.toHaveBeenCalled();
  });
});
