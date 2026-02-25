import { describe, it, expect, vi, beforeEach } from "vitest";
import { isFileAllowed, classifyFiles, evaluateAutomerge } from "./automerge.js";
import type { AutomergeConfig } from "./repo-config.js";
import { LABELS } from "../config.js";

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AutomergeConfig>): AutomergeConfig {
  return {
    dryRun: true,
    allowedPaths: ["**/*.md", "**/*.txt", "docs/**"],
    denyPaths: [".github/**", "package.json"],
    maxFiles: 5,
    maxChangedLines: 80,
    minApprovals: 2,
    requireChecks: true,
    ...overrides,
  };
}

function makeFile(filename: string, additions = 5, deletions = 0) {
  return {
    filename,
    additions,
    deletions,
    changes: additions + deletions,
    status: "modified",
  };
}

function createMockPROperations(overrides?: Record<string, unknown>) {
  return {
    listFiles: vi.fn().mockResolvedValue([]),
    getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ headSha: "abc123" }),
    getCheckRunsForRef: vi.fn().mockResolvedValue({
      totalCount: 0,
      checkRuns: [],
    }),
    getCombinedStatus: vi.fn().mockResolvedValue({
      state: "success",
      totalCount: 0,
    }),
    ...overrides,
  } as any;
}

// ───────────────────────────────────────────────────────────────────────────────
// isFileAllowed
// ───────────────────────────────────────────────────────────────────────────────

describe("isFileAllowed", () => {
  const allow = ["**/*.md", "**/*.txt", "docs/**"];
  const deny = [".github/**", "package.json"];

  it("allows markdown files", () => {
    expect(isFileAllowed("README.md", allow, deny)).toBe(true);
    expect(isFileAllowed("docs/guide.md", allow, deny)).toBe(true);
    expect(isFileAllowed("src/deep/nested/help.md", allow, deny)).toBe(true);
  });

  it("allows text files", () => {
    expect(isFileAllowed("CHANGELOG.txt", allow, deny)).toBe(true);
    expect(isFileAllowed("notes/todo.txt", allow, deny)).toBe(true);
  });

  it("allows files matching docs/** glob", () => {
    expect(isFileAllowed("docs/api.ts", allow, deny)).toBe(true);
    expect(isFileAllowed("docs/deep/nested/thing.js", allow, deny)).toBe(true);
  });

  it("denies files in .github/ even if they match allow patterns", () => {
    expect(isFileAllowed(".github/workflows/ci.yml", allow, deny)).toBe(false);
    expect(isFileAllowed(".github/README.md", allow, deny)).toBe(false);
  });

  it("denies package.json", () => {
    expect(isFileAllowed("package.json", allow, deny)).toBe(false);
  });

  it("denies files that don't match any allow pattern", () => {
    expect(isFileAllowed("src/index.ts", allow, deny)).toBe(false);
    expect(isFileAllowed("lib/utils.js", allow, deny)).toBe(false);
  });

  it("deny takes precedence over allow", () => {
    // A file that matches both allow and deny should be denied
    const denyAll = ["**/*.md"];
    expect(isFileAllowed("README.md", allow, denyAll)).toBe(false);
  });

  it("handles empty allow patterns (nothing allowed)", () => {
    expect(isFileAllowed("README.md", [], deny)).toBe(false);
  });

  it("handles empty deny patterns (nothing denied)", () => {
    expect(isFileAllowed("README.md", allow, [])).toBe(true);
    expect(isFileAllowed("src/index.ts", allow, [])).toBe(false);
  });

  it("handles dotfiles correctly with dot option", () => {
    const dotAllow = ["**/*.yml"];
    expect(isFileAllowed(".prettierrc.yml", dotAllow, [])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// classifyFiles
// ───────────────────────────────────────────────────────────────────────────────

describe("classifyFiles", () => {
  const config = makeConfig();

  it("returns ineligible for empty file list", () => {
    const result = classifyFiles([], config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("no files");
  });

  it("returns eligible for a single allowed markdown file", () => {
    const files = [makeFile("README.md", 3, 2)];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when file count exceeds maxFiles", () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`doc${i}.md`, 1));
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("too many files");
    expect(result.reason).toContain("6");
  });

  it("returns eligible when file count equals maxFiles", () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`doc${i}.md`, 1));
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when total changed lines exceeds maxChangedLines", () => {
    const files = [makeFile("docs/large.md", 50, 40)]; // 90 lines > 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("too many changed lines");
  });

  it("returns eligible when total changed lines equals maxChangedLines", () => {
    const files = [makeFile("docs/exact.md", 40, 40)]; // 80 lines = 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("counts additions and deletions in total changed lines", () => {
    const files = [
      makeFile("a.md", 20, 10), // 30
      makeFile("b.md", 30, 25), // 55
    ];
    // Total: 85 > 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("85");
  });

  it("returns ineligible when a file doesn't pass path rules", () => {
    const files = [
      makeFile("README.md", 5),
      makeFile("src/index.ts", 5), // not in allowed paths
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("src/index.ts");
  });

  it("returns ineligible when a file is in deny list", () => {
    const files = [
      makeFile("README.md", 5),
      makeFile("package.json", 1),
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("package.json");
  });

  it("returns eligible when all files pass all checks", () => {
    const files = [
      makeFile("README.md", 10, 5),
      makeFile("docs/guide.md", 15, 10),
      makeFile("CHANGELOG.txt", 5, 0),
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain("passed");
  });

  it("rejects renamed file when source path is denied", () => {
    const files = [
      {
        filename: "docs/ci-config.md",
        additions: 5,
        deletions: 0,
        changes: 5,
        status: "renamed",
        previous_filename: ".github/ci.yml",
      },
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain(".github/ci.yml");
    expect(result.reason).toContain("renamed");
  });

  it("allows renamed file when both source and destination pass", () => {
    const files = [
      {
        filename: "docs/new-guide.md",
        additions: 2,
        deletions: 0,
        changes: 2,
        status: "renamed",
        previous_filename: "docs/old-guide.md",
      },
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// evaluateAutomerge
// ───────────────────────────────────────────────────────────────────────────────

describe("evaluateAutomerge", () => {
  const baseRef = { owner: "org", repo: "repo", prNumber: 42 };
  const trustedReviewers = ["alice", "bob"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when config is null (feature disabled)", async () => {
    const prs = createMockPROperations();
    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config: null,
      trustedReviewers,
    });
    expect(result.action).toBe("skipped");
    expect(prs.listFiles).not.toHaveBeenCalled();
  });

  it("adds label when all conditions pass", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result.action).toBe("labeled");
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
  });

  it("returns noop when label already present and all conditions pass", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result).toEqual({ action: "noop", labeled: true });
    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("removes label when files are ineligible", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/index.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("unlabeled");
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
  });

  it("returns noop (not labeled) when files ineligible and label not present", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/index.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result).toEqual({ action: "noop", labeled: false });
    expect(prs.removeLabel).not.toHaveBeenCalled();
  });

  it("does not add label when approvals are insufficient", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])), // only 1, need 2
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result).toEqual({ action: "noop", labeled: false });
    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("removes label when approvals drop below threshold", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("unlabeled");
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
  });

  it("does not add label when CI is failing", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "failure" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result).toEqual({ action: "noop", labeled: false });
  });

  it("skips CI check when requireChecks is false", async () => {
    const config = makeConfig({ requireChecks: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("labeled");
    expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
  });

  it("fetches headSha from PR when not provided", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ headSha: "fetched-sha" }),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 0,
        checkRuns: [],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      // headSha intentionally not provided
    });

    expect(prs.get).toHaveBeenCalledWith(baseRef);
    expect(prs.getCheckRunsForRef).toHaveBeenCalledWith("org", "repo", "fetched-sha");
  });

  it("uses pre-fetched currentLabels when provided", async () => {
    const config = makeConfig({ requireChecks: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      currentLabels: [],
    });

    expect(prs.getLabels).not.toHaveBeenCalled();
  });

  it("uses earlyExitThreshold when fetching files", async () => {
    const config = makeConfig({ maxFiles: 3 });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(prs.listFiles).toHaveBeenCalledWith(baseRef, { earlyExitThreshold: 3 });
  });

  it("short-circuits at file classification (does not check approvals)", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    // Files ineligible → should not proceed to approvals
    expect(prs.getApproverLogins).not.toHaveBeenCalled();
  });

  it("short-circuits at approvals (does not check CI)", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])), // only 1, need 2
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    // Approvals insufficient → should not proceed to CI
    expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
  });

  it("propagates errors from API calls", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockRejectedValue(new Error("API error")),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await expect(
      evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
      })
    ).rejects.toThrow("API error");
  });

  it("only counts approvals from trusted reviewers", async () => {
    const config = makeConfig({ minApprovals: 2 });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      // "charlie" is not in trustedReviewers
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "charlie"])),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers: ["alice", "bob"],
    });

    // Only alice counts (bob not approved, charlie not trusted)
    expect(result).toEqual({ action: "noop", labeled: false });
  });
});
