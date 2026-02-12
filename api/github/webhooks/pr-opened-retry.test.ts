import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LinkedIssue } from "../../lib/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level mocks — vi.mock calls are hoisted before imports
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

const mockGetLinkedIssues = vi.fn<
  [unknown, string, string, number],
  Promise<LinkedIssue[]>
>();
vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: (...args: [unknown, string, string, number]) =>
    mockGetLinkedIssues(...args),
}));

const mockHasClosingKeywordForRepo = vi.fn<
  [string | null | undefined, string, string],
  boolean
>();
vi.mock("../../lib/closing-keywords.js", () => ({
  hasClosingKeywordForRepo: (...args: [string | null | undefined, string, string]) =>
    mockHasClosingKeywordForRepo(...args),
}));

const mockProcessImplementationIntake = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: (...args: unknown[]) =>
    mockProcessImplementationIntake(...args),
  recalculateLeaderboardForPR: vi.fn().mockResolvedValue(undefined),
}));

const mockCreateIssueOperations = vi.fn();
const mockLoadRepositoryConfig = vi.fn();
vi.mock("../../lib/index.js", () => ({
  createIssueOperations: (...args: unknown[]) => mockCreateIssueOperations(...args),
  createPROperations: vi.fn(() => ({
    comment: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
  })),
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: vi.fn(),
  loadRepositoryConfig: (...args: unknown[]) => mockLoadRepositoryConfig(...args),
  getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  evaluateMergeReadiness: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks are hoisted
import { app as registerWebhookApp } from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: { info: vi.fn(), error: vi.fn() },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const e of event) handlers.set(e, handler);
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

function defaultRepoConfig() {
  return {
    governance: {
      pr: {
        maxPRsPerIssue: 3,
        trustedReviewers: [],
        intake: [{ method: "update" }],
        mergeReady: null,
      },
      proposals: {
        discussion: { exits: [{ type: "manual" }] },
        voting: { exits: [{ type: "manual" }] },
        extendedVoting: { exits: [{ type: "manual" }] },
      },
    },
  };
}

function buildPROpenedContext(overrides?: {
  prNumber?: number;
  prBody?: string | null;
}) {
  const commentFn = vi.fn().mockResolvedValue(undefined);
  return {
    payload: {
      pull_request: {
        number: overrides?.prNumber ?? 18,
        body: overrides?.prBody ?? "Fixes #16",
        updated_at: "2026-02-12T10:00:00Z",
      },
      repository: {
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
        owner: { login: "hivemoot" },
      },
    },
    octokit: {},
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    _commentFn: commentFn,
  };
}

const READY_ISSUE: LinkedIssue = {
  number: 16,
  title: "Fix legacy notification matching",
  state: "OPEN",
  labels: { nodes: [{ name: "phase:ready-to-implement" }] },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("pull_request.opened — linked-issue retry on GraphQL lag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockLoadRepositoryConfig.mockResolvedValue(defaultRepoConfig());
    mockCreateIssueOperations.mockReturnValue({
      comment: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve linked issues on first try without retry", async () => {
    mockGetLinkedIssues.mockResolvedValue([READY_ISSUE]);
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;
    const ctx = buildPROpenedContext();

    await handler(ctx);

    // Only one call — no retry needed
    expect(mockGetLinkedIssues).toHaveBeenCalledTimes(1);
    expect(mockHasClosingKeywordForRepo).not.toHaveBeenCalled();
    expect(mockProcessImplementationIntake).toHaveBeenCalledTimes(1);
    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIssues: [READY_ISSUE] })
    );
  });

  it("should retry when initial query is empty and body has closing keywords", async () => {
    // First call: empty (lag). Second call: populated.
    mockGetLinkedIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([READY_ISSUE]);
    mockHasClosingKeywordForRepo.mockReturnValue(true);

    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;
    const ctx = buildPROpenedContext();

    const promise = handler(ctx);
    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIssues: [READY_ISSUE] })
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 18, resolutionSource: "graphql-retry" }),
      expect.stringContaining("Linked issues resolved after retry")
    );
  });

  it("should suppress no-linked warning when retry still empty but keywords present", async () => {
    mockGetLinkedIssues.mockResolvedValue([]);
    mockHasClosingKeywordForRepo.mockReturnValue(true);

    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;
    const ctx = buildPROpenedContext();

    const promise = handler(ctx);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIssues: [] })
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 18 }),
      expect.stringContaining("Suppressing no-linked warning")
    );
  });

  it("should post no-linked warning when no closing keywords and GraphQL empty", async () => {
    mockGetLinkedIssues.mockResolvedValue([]);
    mockHasClosingKeywordForRepo.mockReturnValue(false);

    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;
    const ctx = buildPROpenedContext({ prBody: "This is a general cleanup PR" });

    await handler(ctx);

    // No retry — no closing keywords
    expect(mockGetLinkedIssues).toHaveBeenCalledTimes(1);
    expect(mockHasClosingKeywordForRepo).toHaveBeenCalledTimes(1);
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionSource: "graphql", hasClosingKeyword: false }),
      expect.stringContaining("No linked issues resolved")
    );
  });

  it("should pass empty linkedIssues to intake when truly unlinked", async () => {
    mockGetLinkedIssues.mockResolvedValue([]);
    mockHasClosingKeywordForRepo.mockReturnValue(false);

    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;
    const ctx = buildPROpenedContext({ prBody: null });

    await handler(ctx);

    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIssues: [] })
    );
  });

  it("should handle two identical PRs consistently via retry", async () => {
    // Simulate the exact scenario from issue #21:
    // PR #17 hits GraphQL after index is ready → immediate success
    // PR #18 hits GraphQL before index is ready → empty → retry → success
    // Both should ultimately resolve to the same linked issue.

    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened")!;

    // PR #17: immediate success
    mockGetLinkedIssues.mockResolvedValue([READY_ISSUE]);
    const ctx17 = buildPROpenedContext({ prNumber: 17 });
    await handler(ctx17);

    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 17, linkedIssues: [READY_ISSUE] })
    );

    vi.clearAllMocks();
    mockLoadRepositoryConfig.mockResolvedValue(defaultRepoConfig());
    mockCreateIssueOperations.mockReturnValue({
      comment: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });

    // PR #18: empty on first try, populated on retry
    mockGetLinkedIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([READY_ISSUE]);
    mockHasClosingKeywordForRepo.mockReturnValue(true);

    const ctx18 = buildPROpenedContext({ prNumber: 18 });
    const promise = handler(ctx18);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Both PRs resolved to the same linked issue
    expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 18, linkedIssues: [READY_ISSUE] })
    );
  });
});
