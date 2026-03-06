import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand, type CommandContext } from "./handlers.js";
import { LABELS } from "../../config.js";

const { mockLoadRepositoryConfig, mockGetDefaultConfig } = vi.hoisted(() => {
  const READINESS_CONFIG = {
    version: 1,
    governance: {
      proposals: {
        discussion: {
          exits: [{ type: "manual" }],
          durationMs: 0,
          readinessSignal: { enabled: true, minEndorsements: 3 },
        },
        voting: { exits: [{ type: "manual" }], durationMs: 0 },
        extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
      },
      pr: null,
    },
    standup: { enabled: false, category: "" },
  };
  return {
    mockLoadRepositoryConfig: vi.fn().mockImplementation(async () => READINESS_CONFIG),
    mockGetDefaultConfig: vi.fn().mockReturnValue(READINESS_CONFIG),
    READINESS_CONFIG,
  };
});

const READINESS_CONFIG = {
  version: 1,
  governance: {
    proposals: {
      discussion: {
        exits: [{ type: "manual" }],
        durationMs: 0,
        readinessSignal: { enabled: true, minEndorsements: 3 },
      },
      voting: { exits: [{ type: "manual" }], durationMs: 0 },
      extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
    },
    pr: null,
  },
  standup: { enabled: false, category: "" },
};

vi.mock("../index.js", () => ({
  createIssueOperations: vi.fn(() => ({})),
  createGovernanceService: vi.fn(() => ({})),
  createRepositoryLabelService: vi.fn(() => ({})),
  createPROperations: vi.fn(() => ({})),
  loadRepositoryConfig: mockLoadRepositoryConfig,
  getDefaultConfig: mockGetDefaultConfig,
}));

vi.mock("../discussions.js", () => ({
  getRepoDiscussionInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("../llm/provider.js", () => ({
  getLLMReadiness: vi.fn(() => ({ ready: false, reason: "not_configured" })),
}));

vi.mock("../llm/blueprint.js", () => ({
  BlueprintGenerator: vi.fn(),
  createMinimalPlan: vi.fn(),
}));

vi.mock("../llm/commit-message.js", () => ({
  CommitMessageGenerator: vi.fn(),
  formatCommitMessage: vi.fn(),
}));

vi.mock("../merge-readiness.js", () => ({
  evaluatePreflightChecks: vi.fn(),
}));

/**
 * Build a mock comment that contains @hivemoot ready from the given user.
 */
function makeReadyComment(id: number, login: string, appId?: number): {
  id: number;
  body: string;
  user: { login: string };
  performed_via_github_app: { id: number; name: string } | null;
} {
  return {
    id,
    body: "@hivemoot ready",
    user: { login },
    performed_via_github_app: appId !== undefined ? { id: appId, name: "hivemoot" } : null,
  };
}

/**
 * Build a mock readiness advisory comment (posted by the bot).
 */
function makeAdvisoryComment(id: number, issueNumber: number, botAppId: number): {
  id: number;
  body: string;
  user: { login: string };
  performed_via_github_app: { id: number; name: string };
} {
  const metadata = JSON.stringify({
    version: 1,
    type: "readiness",
    createdAt: "2026-01-01T00:00:00.000Z",
    issueNumber,
  });
  return {
    id,
    body: `<!-- hivemoot-metadata: ${metadata} -->\n🐝 **Discussion appears ready**`,
    user: { login: "hivemoot[bot]" },
    performed_via_github_app: { id: botAppId, name: "hivemoot" },
  };
}

function createMockOctokit(permission = "write", listCommentsData: object[] = []) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
        getContent: vi.fn().mockResolvedValue({
          data: { type: "file", content: Buffer.from("version: 1\n").toString("base64") },
        }),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        updateComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: listCommentsData }),
      },
    },
    graphql: vi.fn().mockResolvedValue({}),
  };
}

function createCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    octokit: createMockOctokit() as unknown as CommandContext["octokit"],
    owner: "test-org",
    repo: "test-repo",
    issueNumber: 42,
    commentId: 100,
    senderLogin: "alice",
    verb: "ready",
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

describe("/ready command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects on pull requests", async () => {
    const ctx = createCtx({ isPullRequest: true });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("rejected");
    expect((result as { status: "rejected"; reason: string }).reason).toMatch(/pull request/i);
  });

  it("rejects when issue is not in discussion phase", async () => {
    const ctx = createCtx({ issueLabels: [{ name: LABELS.VOTING }] });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("rejected");
    expect((result as { status: "rejected"; reason: string }).reason).toMatch(/discussion phase/i);
  });

  it("rejects when readinessSignal feature is not enabled", async () => {
    mockLoadRepositoryConfig.mockResolvedValueOnce({
      ...READINESS_CONFIG,
      governance: {
        ...READINESS_CONFIG.governance,
        proposals: {
          ...READINESS_CONFIG.governance.proposals,
          discussion: {
            exits: [{ type: "manual" }],
            durationMs: 0,
            readinessSignal: null,
          },
        },
      },
    });
    const ctx = createCtx();
    const result = await executeCommand(ctx);
    expect(result.status).toBe("rejected");
    expect((result as { status: "rejected"; reason: string }).reason).toMatch(/not enabled/i);
  });

  it("records signal without posting advisory when below threshold", async () => {
    // Only 1 participant (sender), threshold is 3 — no advisory yet
    const comments = [makeReadyComment(1, "alice")];
    const octokit = createMockOctokit("write", comments);
    const ctx = createCtx({ octokit: octokit as unknown as CommandContext["octokit"] });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
    expect((result as { status: "executed"; message: string }).message).toMatch(/1\/3/);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("posts advisory comment when threshold is exactly met", async () => {
    // Sender (alice) + 2 others = 3 distinct — threshold met
    const comments = [
      makeReadyComment(1, "alice"),
      makeReadyComment(2, "bob"),
      makeReadyComment(3, "carol"),
    ];
    const octokit = createMockOctokit("write", comments);
    const ctx = createCtx({ octokit: octokit as unknown as CommandContext["octokit"] });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
    expect((result as { status: "executed"; message: string }).message).toMatch(/posted/i);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledOnce();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toMatch(/Discussion appears ready/);
    expect(body).toMatch(/@alice/);
    expect(body).toMatch(/@bob/);
    expect(body).toMatch(/@carol/);
    expect(body).toMatch(/hivemoot-metadata/);
  });

  it("updates existing advisory comment when more participants signal after threshold", async () => {
    const botAppId = 12345;
    const comments = [
      makeReadyComment(1, "alice"),
      makeReadyComment(2, "bob"),
      makeReadyComment(3, "carol"),
      makeAdvisoryComment(99, 42, botAppId), // existing advisory
    ];
    const octokit = createMockOctokit("write", comments);
    // dave is the current sender (4th signal)
    const ctx = createCtx({
      octokit: octokit as unknown as CommandContext["octokit"],
      senderLogin: "dave",
    });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
    expect((result as { status: "executed"; message: string }).message).toMatch(/updated/i);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledOnce();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    const updateCall = octokit.rest.issues.updateComment.mock.calls[0][0] as {
      comment_id: number;
      body: string;
    };
    expect(updateCall.comment_id).toBe(99);
    expect(updateCall.body).toMatch(/@dave/);
  });

  it("deduplicates multiple /ready invocations from the same user", async () => {
    // alice signals 3 times, bob and carol once each — still only 3 distinct
    const comments = [
      makeReadyComment(1, "alice"),
      makeReadyComment(2, "alice"),
      makeReadyComment(3, "alice"),
      makeReadyComment(4, "bob"),
      makeReadyComment(5, "carol"),
    ];
    const octokit = createMockOctokit("write", comments);
    const ctx = createCtx({ octokit: octokit as unknown as CommandContext["octokit"] });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
    // Advisory should list alice, bob, carol — not alice three times
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    const aliceCount = (body.match(/@alice/g) ?? []).length;
    expect(aliceCount).toBe(1);
  });

  it("allows open access — non-maintainer users can invoke /ready", async () => {
    // bob has no collaborator permission (throws 404 as non-collaborator)
    const comments = [
      makeReadyComment(1, "alice"),
      makeReadyComment(2, "bob"),
      makeReadyComment(3, "carol"),
    ];
    const octokit = createMockOctokit("write", comments);
    // Override permission check to return "none" (not a collaborator)
    octokit.rest.repos.getCollaboratorPermissionLevel = vi.fn().mockResolvedValue({
      data: { permission: "none" },
    });
    const ctx = createCtx({
      octokit: octokit as unknown as CommandContext["octokit"],
      senderLogin: "dave",
    });
    // Even though dave has "none" permission, /ready should execute
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
  });

  it("updates existing advisory even when below threshold", async () => {
    // Advisory was posted (somehow), but now re-invoked below threshold — update it
    const botAppId = 12345;
    const comments = [
      makeReadyComment(1, "alice"),
      makeAdvisoryComment(99, 42, botAppId),
    ];
    const octokit = createMockOctokit("write", comments);
    const ctx = createCtx({ octokit: octokit as unknown as CommandContext["octokit"] });
    const result = await executeCommand(ctx);
    expect(result.status).toBe("executed");
    // Should update the existing comment (not threshold met but advisory exists)
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
  });
});
