import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS } from "../../config.js";

const mocks = vi.hoisted(() => {
  return {
    getLinkedIssues: vi.fn(),
    createIssueOperations: vi.fn(),
    createPROperations: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    processImplementationIntake: vi.fn(),
    issuesOps: {
      comment: vi.fn(),
    },
    prOps: {
      removeLabel: vi.fn(),
    },
  };
});

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: mocks.getLinkedIssues,
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: mocks.createIssueOperations,
  createPROperations: mocks.createPROperations,
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: vi.fn(),
  loadRepositoryConfig: mocks.loadRepositoryConfig,
  getOpenPRsForIssue: vi.fn(),
  evaluateMergeReadiness: vi.fn(),
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: mocks.processImplementationIntake,
  recalculateLeaderboardForPR: vi.fn(),
}));

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

function createContext(options?: { changes?: Record<string, unknown> }) {
  return {
    payload: {
      pull_request: {
        number: 49,
        updated_at: "2026-02-15T10:00:00Z",
      },
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
      changes: options?.changes,
    },
    octokit: { graphql: vi.fn() },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("pull_request synchronize and edited handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.createIssueOperations.mockReturnValue(mocks.issuesOps);
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
        },
      },
    });
    mocks.getLinkedIssues.mockResolvedValue([]);
    mocks.prOps.removeLabel.mockResolvedValue(undefined);
  });

  it("processes pull_request.synchronize by clearing merge-ready and re-running intake", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.synchronize");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 79,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };
    mocks.getLinkedIssues.mockResolvedValue([linkedIssue]);

    await handler!(createContext());

    expect(mocks.prOps.removeLabel).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 49 },
      LABELS.MERGE_READY,
    );
    expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "hivemoot",
        repo: "hivemoot-bot",
        prNumber: 49,
        linkedIssues: [linkedIssue],
        trigger: "updated",
      }),
    );
  });

  it("propagates synchronize errors before intake when merge-ready removal fails", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.synchronize");
    expect(handler).toBeDefined();

    mocks.prOps.removeLabel.mockRejectedValueOnce(new Error("remove failed"));

    await expect(handler!(createContext())).rejects.toThrow("remove failed");
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });

  it("skips pull_request.edited when body was not changed", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.edited");
    expect(handler).toBeDefined();

    await handler!(createContext({ changes: { title: { from: "old title" } } }));

    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });

  it("processes pull_request.edited when body changed and forwards editedAt", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.edited");
    expect(handler).toBeDefined();

    await handler!(createContext({ changes: { body: { from: "old body" } } }));

    expect(mocks.getLinkedIssues).toHaveBeenCalledWith(
      expect.anything(),
      "hivemoot",
      "hivemoot-bot",
      49,
    );
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);

    const args = mocks.processImplementationIntake.mock.calls[0][0];
    expect(args.trigger).toBe("edited");
    expect(args.editedAt).toEqual(new Date("2026-02-15T10:00:00Z"));
  });
});
