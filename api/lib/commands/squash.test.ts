import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand, type CommandContext } from "./handlers.js";
import { LABELS } from "../../config.js";

const DEFAULT_PREFLIGHT = {
  checks: [
    { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
    { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
    { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
    { name: "CI checks passing", passed: true, severity: "hard", detail: "All 3 check(s) passed" },
    { name: "Implementation label", passed: true, severity: "advisory", detail: "Has `hivemoot:candidate` label" },
    { name: "Merge-ready label", passed: true, severity: "advisory", detail: "Has `hivemoot:merge-ready` label" },
  ],
  allHardChecksPassed: true,
} as const;

vi.mock("../index.js", () => ({
  createIssueOperations: vi.fn(() => ({})),
  createGovernanceService: vi.fn(() => ({})),
  createPROperations: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
  })),
  loadRepositoryConfig: vi.fn().mockResolvedValue({
    governance: {
      pr: {
        mergeReady: { minApprovals: 1 },
        trustedReviewers: ["alice"],
        staleDays: 3,
        maxPRsPerIssue: 3,
        intake: [],
      },
      proposals: {
        discussion: { exits: [], durationMs: 86400000 },
        voting: { exits: [], durationMs: 86400000 },
        extendedVoting: { exits: [], durationMs: 86400000 },
      },
    },
    version: 1,
    standup: { enabled: false },
  }),
}));

vi.mock("../merge-readiness.js", () => ({
  evaluatePreflightChecks: vi.fn().mockResolvedValue({
    checks: [
      { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
      { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
      { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
      { name: "CI checks passing", passed: true, severity: "hard", detail: "All 3 check(s) passed" },
      { name: "Implementation label", passed: true, severity: "advisory", detail: "Has `hivemoot:candidate` label" },
      { name: "Merge-ready label", passed: true, severity: "advisory", detail: "Has `hivemoot:merge-ready` label" },
    ],
    allHardChecksPassed: true,
  }),
}));

vi.mock("../llm/commit-message.js", () => ({
  CommitMessageGenerator: vi.fn().mockImplementation(function () {
    return {
      generate: vi.fn().mockResolvedValue({
        success: true,
        message: { subject: "Add merge helper", body: "Introduces automatic squash merge after readiness checks pass." },
      }),
    };
  }),
  formatCommitMessage: vi.fn().mockReturnValue(
    "Add merge helper\n\nIntroduces automatic squash merge after readiness checks pass.\n\nPR: #42",
  ),
}));

function createMockOctokit(permission = "admin") {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
        get: vi.fn().mockResolvedValue({ data: { allow_squash_merge: true } }),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { title: "Add merge helper", body: "PR description" },
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { message: "initial commit" } }],
        }),
        merge: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function createPRCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    octokit: createMockOctokit(),
    owner: "test-org",
    repo: "test-repo",
    issueNumber: 42,
    commentId: 100,
    senderLogin: "maintainer",
    verb: "squash",
    freeText: undefined,
    issueLabels: [{ name: LABELS.IMPLEMENTATION }],
    isPullRequest: true,
    appId: 12345,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("/squash command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("squash-merges a PR when all checks pass and commit message is generated", async () => {
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        merge_method: "squash",
        commit_title: "Add merge helper",
      }),
    );
    expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash Preflight");
    expect(body).toContain("Proposed Commit Message");
    expect(body).toContain("Squash merge completed successfully");
  });

  it("rejects /squash on issues", async () => {
    const ctx = createPRCtx({ isPullRequest: false });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("rejects when PR is already closed or merged", async () => {
    const { createPROperations } = await import("../index.js");
    vi.mocked(createPROperations).mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ number: 42, state: "closed", merged: true, headSha: "abc123", mergeable: true }),
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("already closed or merged");
  });

  it("rejects when squash merge is disabled for the repository", async () => {
    const octokit = createMockOctokit();
    octokit.rest.repos.get.mockResolvedValueOnce({ data: { allow_squash_merge: false } });
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash merge is disabled");
  });

  it("blocks merge when hard preflight checks fail", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: false, severity: "hard", detail: "0/1 trusted approvals" },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash Preflight");
    expect(body).toContain("hard checks passed");
    expect(body).toContain("blocked");
  });

  it("fails closed when commit message generation is unavailable", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: false,
            kind: "not_configured",
            reason: "LLM not configured",
          }),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Commit message generation failed");
    expect(body).not.toContain("LLM not configured");
    expect(body).toContain("Retry `/squash` after the generator is healthy");
    expect(body).not.toContain("Fix commit-message generation");
  });

  it("fails closed when commit message generation throws", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockRejectedValue(new Error("upstream timeout")),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Commit message generation failed");
    expect(body).toContain("Retry `/squash` after the generator is healthy");
  });

  it("blocks merge when final verification changes before merge", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks)
      .mockResolvedValueOnce(DEFAULT_PREFLIGHT as any)
      .mockResolvedValueOnce({
        checks: [
          { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
          { name: "CI checks passing", passed: false, severity: "hard", detail: "1 check run(s) still in progress" },
        ],
        allHardChecksPassed: false,
      } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("final verification");
    expect(body).toContain("blocked");
  });

  it("uses PR fallback commit body when generator returns an empty body", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: true,
            message: { subject: "Tighten merge command", body: "   " },
          }),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        commit_title: "Tighten merge command",
        commit_message: "PR: #42",
      }),
    );
  });

  it("fails closed when GitHub squash merge API returns an error", async () => {
    const octokit = createMockOctokit();
    octokit.rest.pulls.merge.mockRejectedValueOnce(new Error("merge blocked by branch protection"));
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash merge failed due to a GitHub merge API error");
  });
});
