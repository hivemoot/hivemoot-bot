import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    parseCommand: vi.fn(),
    executeCommand: vi.fn(),
    getLinkedIssues: vi.fn(),
    createIssueOperations: vi.fn(),
    createPROperations: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    processImplementationIntake: vi.fn(),
    issuesOps: {},
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

vi.mock("../../lib/llm/provider.js", () => ({
  getLLMReadiness: vi.fn(() => ({ ready: true })),
}));

vi.mock("../../lib/commands/index.js", () => ({
  parseCommand: mocks.parseCommand,
  executeCommand: mocks.executeCommand,
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

function createContext(options?: {
  commentBody?: string;
  isPullRequest?: boolean;
  commentAppId?: number | null;
}) {
  const commentBody = options?.commentBody ?? "Looks good";
  const isPullRequest = options?.isPullRequest ?? false;
  const commentAppId = options?.commentAppId ?? null;

  return {
    octokit: {},
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    payload: {
      issue: {
        number: 21,
        labels: [{ name: "hivemoot:discussion" }],
        pull_request: isPullRequest
          ? { url: "https://api.github.com/repos/hivemoot/hivemoot-bot/pulls/21" }
          : undefined,
      },
      comment: {
        id: 9001,
        body: commentBody,
        user: { login: "contributor" },
        performed_via_github_app:
          commentAppId === null
            ? null
            : { id: commentAppId },
      },
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
    },
  };
}

describe("issue_comment.created handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseCommand.mockReturnValue(null);
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.getLinkedIssues.mockResolvedValue([]);
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
    mocks.processImplementationIntake.mockResolvedValue(undefined);
  });

  it("skips comments authored via this GitHub App", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    const context = createContext({
      commentBody: "@hivemoot /vote",
      commentAppId: 12345,
      isPullRequest: true,
    });

    await handler!(context);

    expect(mocks.parseCommand).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });

  it("dispatches recognized commands and returns before intake processing", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    mocks.parseCommand.mockReturnValue({
      verb: "vote",
      freeText: null,
    });

    const context = createContext({
      commentBody: "@hivemoot /vote",
      isPullRequest: true,
    });

    await handler!(context);

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.loadRepositoryConfig).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });

  it("ignores non-command comments on issues", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    const context = createContext({
      commentBody: "Needs more design detail",
      isPullRequest: false,
    });

    await handler!(context);

    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.loadRepositoryConfig).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });

  it("processes non-command PR comments through implementation intake", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    const linkedIssues = [{ number: 79, labels: { nodes: [] } }];
    mocks.getLinkedIssues.mockResolvedValue(linkedIssues);

    const context = createContext({
      commentBody: "Can we add one more assertion?",
      isPullRequest: true,
    });

    await handler!(context);

    expect(mocks.getLinkedIssues).toHaveBeenCalledWith(expect.anything(), "hivemoot", "hivemoot-bot", 21);
    expect(mocks.loadRepositoryConfig).toHaveBeenCalledWith(expect.anything(), "hivemoot", "hivemoot-bot");
    expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "hivemoot",
        repo: "hivemoot-bot",
        prNumber: 21,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: 3,
      })
    );
  });

  it("logs and rethrows when intake processing fails", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    const context = createContext({
      commentBody: "Please re-run checks",
      isPullRequest: true,
    });

    const failure = new Error("intake blew up");
    mocks.processImplementationIntake.mockRejectedValue(failure);

    await expect(handler!(context)).rejects.toThrow("intake blew up");
    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: failure,
        issue: 21,
        repo: "hivemoot/hivemoot-bot",
      }),
      "Failed to process comment"
    );
  });
});
