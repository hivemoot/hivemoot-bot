import { beforeEach, describe, expect, it, vi } from "vitest";

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
    prOps: {},
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

function createContext(body: string | null) {
  return {
    payload: {
      pull_request: {
        number: 49,
        body,
      },
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
    },
    octokit: { graphql: vi.fn() },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("pull_request.opened linked issue resolution", () => {
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
  });

  it("posts no-linked warning when no closing keyword is present", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    mocks.getLinkedIssues.mockResolvedValue([]);

    await handler!(createContext("Related to #21"));

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(1);
    expect(mocks.issuesOps.comment).toHaveBeenCalledTimes(1);
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
  });

  it("retries once when closing keywords are present and initial lookup is empty", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 21,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };
    mocks.getLinkedIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([linkedIssue]);

    const context = createContext("Fixes #21");
    const handlerPromise = handler!(context);
    await vi.advanceTimersByTimeAsync(2000);
    await handlerPromise;
    vi.useRealTimers();

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssues: [linkedIssue],
      })
    );
  });

  it("suppresses no-linked warning when retry remains empty with closing keyword", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    mocks.getLinkedIssues.mockResolvedValue([]);

    const context = createContext("Resolves #21");
    const handlerPromise = handler!(context);
    await vi.advanceTimersByTimeAsync(2000);
    await handlerPromise;
    vi.useRealTimers();

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 49, resolutionSource: "heuristic-suppressed" }),
      expect.stringContaining("suppressing warning")
    );
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
  });
});
