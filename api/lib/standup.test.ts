import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectStandupData,
  hasAnyContent,
  formatStandupComment,
  validateLLMReferences,
  computeHealthSignals,
  type StandupData,
  type StandupClient,
  type StandupPROperations,
  type StandupLLMContent,
} from "./standup.js";
import { buildStandupUserPrompt } from "./llm/prompts.js";

/**
 * Tests for Standup Module
 *
 * Verifies:
 * - Data collection with required vs optional sections
 * - Content detection (hasAnyContent)
 * - Comment formatting (full, quiet day, truncation)
 * - LLM reference validation (valid, hallucinated, threshold)
 * - Health signal generation
 */

// ───────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ───────────────────────────────────────────────────────────────────────────────

function createMockOctokit(): StandupClient & {
  rest: {
    issues: { listForRepo: ReturnType<typeof vi.fn> };
    pulls: {
      list: ReturnType<typeof vi.fn>;
      listCommits: ReturnType<typeof vi.fn>;
    };
    repos: {
      get: ReturnType<typeof vi.fn>;
      listCommits: ReturnType<typeof vi.fn>;
    };
  };
} {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({ data: { open_issues_count: 0 } }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
  };
}

function createMockPROperations(): StandupPROperations & {
  findPRsWithLabel: ReturnType<typeof vi.fn>;
} {
  return {
    findPRsWithLabel: vi.fn().mockResolvedValue([]),
  };
}

function createEmptyStandupData(overrides?: Partial<StandupData>): StandupData {
  return {
    discussionPhase: [],
    votingPhase: [],
    extendedVoting: [],
    readyToImplement: [],
    repoFullName: "hivemoot/colony",
    reportDate: "2026-02-06",
    dayNumber: 42,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Data Collection
// ───────────────────────────────────────────────────────────────────────────────

describe("collectStandupData", () => {
  it("should collect pipeline issues by label", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // Set up different label results
    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({
        data: [{ number: 1, title: "Add feature X", pull_request: undefined }],
      })
      .mockResolvedValueOnce({
        data: [{ number: 2, title: "Improve Y" }],
      })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 3, title: "Build Z" },
          { number: 4, title: "Build W" },
        ],
      });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.discussionPhase).toHaveLength(1);
    expect(result.votingPhase).toHaveLength(1);
    expect(result.extendedVoting).toHaveLength(0);
    expect(result.readyToImplement).toHaveLength(2);
    expect(result.repoFullName).toBe("hivemoot/colony");
    expect(result.dayNumber).toBe(42);
  });

  it("should filter out pull requests from issue results", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({
        data: [
          { number: 1, title: "Real issue" },
          { number: 10, title: "This is a PR", pull_request: { url: "..." } },
        ],
      })
      .mockResolvedValue({ data: [] });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.discussionPhase).toHaveLength(1);
    expect(result.discussionPhase[0].number).toBe(1);
  });

  it("should gracefully handle optional section failures", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // Pipeline succeeds
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    // PR operations fail
    prs.findPRsWithLabel.mockRejectedValue(new Error("API rate limited"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // Pipeline data still present
    expect(result.discussionPhase).toEqual([]);
    // Optional data undefined (graceful degradation)
    expect(result.implementationPRs).toBeUndefined();
    expect(result.mergeReadyPRs).toBeUndefined();
    expect(result.stalePRs).toBeUndefined();
  });

  it("should use placeholder title/author when PR details fetch fails", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    // PR details fetch fails
    octokit.rest.pulls.list.mockRejectedValue(new Error("Rate limited"));
    // But label-based search succeeds
    prs.findPRsWithLabel.mockResolvedValueOnce([{ number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [] }]);
    prs.findPRsWithLabel.mockResolvedValue([]);

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // PR ref falls back to placeholder
    expect(result.implementationPRs).toHaveLength(1);
    expect(result.implementationPRs![0].title).toBe("PR #10");
    expect(result.implementationPRs![0].author).toBe("unknown");
  });

  it("should only call pulls.list once for all enrichment", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 10, title: "Real Title", user: { login: "agent-1" }, merged_at: null, labels: [] }],
    });
    prs.findPRsWithLabel
      .mockResolvedValueOnce([{ number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [] }])
      .mockResolvedValue([]);

    await collectStandupData(octokit, prs, "hivemoot", "colony", "2026-02-06", 42);

    // pulls.list called twice: 1x for enrichment (not 3x) + 1x for merged PRs
    expect(octokit.rest.pulls.list).toHaveBeenCalledTimes(2);
  });

  it("should collect recently merged PRs within reporting window", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    // First call: open PRs for enrichment. Second call: closed PRs for merged.
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 20, title: "Merged today", user: { login: "agent-1" }, merged_at: "2026-02-06T14:00:00Z", labels: [] },
          { number: 21, title: "Merged yesterday", user: { login: "agent-2" }, merged_at: "2026-02-05T10:00:00Z", labels: [] },
          { number: 22, title: "Not merged", user: { login: "agent-3" }, merged_at: null, labels: [] },
        ],
      });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.recentlyMergedPRs).toHaveLength(1);
    expect(result.recentlyMergedPRs![0]).toEqual({
      number: 20,
      title: "Merged today",
      author: "agent-1",
    });
  });

  it("should collect recently rejected issues within reporting window", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // 4 pipeline calls + 1 rejected issues call
    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({ data: [] }) // discussion
      .mockResolvedValueOnce({ data: [] }) // voting
      .mockResolvedValueOnce({ data: [] }) // extended
      .mockResolvedValueOnce({ data: [] }) // ready
      .mockResolvedValueOnce({
        data: [
          { number: 5, title: "Bad proposal", closed_at: "2026-02-06T16:00:00Z" },
          { number: 6, title: "Old rejection", closed_at: "2026-02-04T10:00:00Z" },
          { number: 7, title: "PR not issue", closed_at: "2026-02-06T12:00:00Z", pull_request: { url: "..." } },
        ],
      });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.recentlyRejected).toHaveLength(1);
    expect(result.recentlyRejected![0]).toEqual({
      number: 5,
      title: "Bad proposal",
    });
  });

  it("should subtract open PR count from open_issues_count", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.repos.get.mockResolvedValue({ data: { open_issues_count: 15 } });
    // 3 open PRs returned from enrichment call
    octokit.rest.pulls.list
      .mockResolvedValueOnce({
        data: [
          { number: 10, title: "PR A", user: { login: "a" }, merged_at: null, labels: [] },
          { number: 11, title: "PR B", user: { login: "b" }, merged_at: null, labels: [] },
          { number: 12, title: "PR C", user: { login: "c" }, merged_at: null, labels: [] },
        ],
      })
      .mockResolvedValue({ data: [] });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // 15 - 3 open PRs = 12 actual issues
    expect(result.openIssueCount).toBe(12);
  });

  it("should gracefully handle repos.get failure", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.repos.get.mockRejectedValue(new Error("Not found"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.openIssueCount).toBeUndefined();
  });

  it("should collect direct commits not attributable to merged PRs", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    // Enrichment: empty
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      // Merged PRs
      .mockResolvedValueOnce({
        data: [
          { number: 30, title: "Feature PR", user: { login: "dev" }, merged_at: "2026-02-06T10:00:00Z", labels: [] },
        ],
      });
    // PR #30 commits
    octokit.rest.pulls.listCommits.mockResolvedValueOnce({
      data: [
        { sha: "aaa1111", commit: { message: "feat: add feature", author: { name: "dev" } } },
      ],
    });
    // Branch commits for the day
    octokit.rest.repos.listCommits.mockResolvedValueOnce({
      data: [
        { sha: "aaa1111", commit: { message: "feat: add feature", author: { name: "dev" } }, author: { login: "dev" } },
        { sha: "bbb2222", commit: { message: "chore: fix typo", author: { name: "admin" } }, author: { login: "admin" } },
        { sha: "ccc3333", commit: { message: "Merge PR (#30)", author: { name: "bot" } }, author: { login: "bot" } },
      ],
    });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // aaa1111 is a PR commit (filtered by SHA), ccc3333 is a squash merge commit
    // (filtered by PR number in message), only bbb2222 is a direct commit
    expect(result.directCommits).toHaveLength(1);
    expect(result.directCommits![0]).toEqual({
      sha: "bbb2222",
      message: "chore: fix typo",
      author: "admin",
    });
  });

  it("should handle null user on merged PRs with ghost fallback", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 40, title: "Ghost PR", user: null, merged_at: "2026-02-06T08:00:00Z", labels: [] },
        ],
      });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.recentlyMergedPRs).toHaveLength(1);
    expect(result.recentlyMergedPRs![0].author).toBe("ghost");
  });

  it("should gracefully handle merged PRs fetch failure", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    // Enrichment succeeds, merged PRs fetch fails
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("API timeout"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.recentlyMergedPRs).toBeUndefined();
    expect(result.directCommits).toBeUndefined();
  });

  it("should gracefully handle direct commits grouping failure", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 50, title: "Merged", user: { login: "dev" }, merged_at: "2026-02-06T10:00:00Z", labels: [] },
        ],
      });
    // Commit listing fails
    octokit.rest.pulls.listCommits.mockRejectedValue(new Error("fail"));
    octokit.rest.repos.listCommits.mockRejectedValue(new Error("fail"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // Merged PRs still collected despite commit grouping failure
    expect(result.recentlyMergedPRs).toHaveLength(1);
    expect(result.directCommits).toBeUndefined();
  });

  it("should gracefully handle rejected issues fetch failure", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // Pipeline calls succeed
    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      // Rejected issues call fails
      .mockRejectedValueOnce(new Error("API error"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.recentlyRejected).toBeUndefined();
  });

  it("should use commit author name when login is unavailable", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 60, title: "PR", user: { login: "dev" }, merged_at: "2026-02-06T10:00:00Z", labels: [] },
        ],
      });
    octokit.rest.pulls.listCommits.mockResolvedValue({ data: [] });
    octokit.rest.repos.listCommits.mockResolvedValue({
      data: [
        // author is empty object (no login), commit.author has name
        { sha: "ddd4444", commit: { message: "direct push", author: { name: "Jane Doe" } }, author: {} },
        // author is null, commit.author is null
        { sha: "eee5555", commit: { message: "mystery commit", author: null }, author: null },
      ],
    });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.directCommits).toHaveLength(2);
    expect(result.directCommits![0].author).toBe("Jane Doe");
    expect(result.directCommits![1].author).toBe("unknown");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Content Detection
// ───────────────────────────────────────────────────────────────────────────────

describe("hasAnyContent", () => {
  it("should return false for completely empty data", () => {
    expect(hasAnyContent(createEmptyStandupData())).toBe(false);
  });

  it("should return true when pipeline has issues", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Test" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are implementation PRs", () => {
    const data = createEmptyStandupData({
      implementationPRs: [{ number: 10, title: "PR", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are merged PRs", () => {
    const data = createEmptyStandupData({
      recentlyMergedPRs: [{ number: 5, title: "Merged PR", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are direct commits", () => {
    const data = createEmptyStandupData({
      directCommits: [{ sha: "abc1234", message: "fix", author: "admin" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Formatting
// ───────────────────────────────────────────────────────────────────────────────

describe("formatStandupComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-07T00:05:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should format quiet day when no content", () => {
    const data = createEmptyStandupData();
    const result = formatStandupComment(data);

    expect(result).toContain("Colony Report — Day 42");
    expect(result).toContain("The colony rests");
    expect(result).toContain("hivemoot-metadata:");
    expect(result).toContain('"type":"standup"');
    expect(result).toContain('"day":42');
    expect(result).toContain("buzz buzz");
  });

  it("should format full report with pipeline data", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature A" }],
      votingPhase: [{ number: 2, title: "Feature B" }],
      readyToImplement: [
        { number: 3, title: "Feature C" },
        { number: 4, title: "Feature D" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Colony Report — Day 42");
    expect(result).toContain("open issues");
    expect(result).toContain("PRs in flight");
    expect(result).toContain("hivemoot-metadata:");
  });

  it("should include LLM content when provided", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature" }],
    });

    const llmContent: StandupLLMContent = {
      narrative: "A productive day in the colony.",
      keyUpdates: ["Feature approved"],
      queensTake: {
        wentWell: "Quick consensus on Feature.",
        focusAreas: "PR reviews needed.",
        needsAttention: "",
      },
    };

    const result = formatStandupComment(data, llmContent);

    expect(result).toContain("A productive day in the colony.");
    expect(result).toContain("Queen's Take");
    expect(result).toContain("Quick consensus on Feature.");
    expect(result).toContain("PR reviews needed.");
  });

  it("should omit needsAttention when empty", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature" }],
    });

    const llmContent: StandupLLMContent = {
      narrative: "Summary.",
      keyUpdates: ["Update"],
      queensTake: {
        wentWell: "Things went well.",
        focusAreas: "Focus here.",
        needsAttention: "",
      },
    };

    const result = formatStandupComment(data, llmContent);

    expect(result).not.toContain("Needs addressing:");
  });

  it("should format implementation activity table", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Implement X", author: "agent-1" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Implementation Activity");
    expect(result).toContain("#10");
    expect(result).toContain("@agent-1");
  });

  it("should escape pipe characters in PR titles for table formatting", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Add input|output handling", author: "agent-1" },
      ],
    });

    const result = formatStandupComment(data);

    // Pipe should be escaped so it doesn't break the markdown table
    expect(result).toContain("Add input\\|output handling");
    expect(result).not.toContain("Add input|output handling");
  });

  it("should format merged PRs", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      recentlyMergedPRs: [{ number: 5, title: "Feature X", author: "agent-1" }],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("#5");
    expect(result).toContain("Feature X");
  });

  it("should keep detailed merged PR list when merged count is at threshold", () => {
    const merged = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      title: `Feature ${i + 1}`,
      author: "agent-1",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      recentlyMergedPRs: merged,
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("**#8** Feature 8");
    expect(result).not.toContain("View all merged PRs");
  });

  it("should render compact merged summary and link when merged count exceeds threshold", () => {
    const merged = Array.from({ length: 9 }, (_, i) => ({
      number: i + 1,
      title: `Feature ${i + 1}`,
      author: "agent-1",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-08",
      recentlyMergedPRs: merged,
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("**9 PRs merged**");
    expect(result).toContain(
      "[View all merged PRs for 2026-02-08](https://github.com/hivemoot/colony/pulls?q=is%3Apr%20is%3Amerged%20merged%3A2026-02-08..2026-02-08)"
    );
    expect(result).not.toContain("**#1** Feature 1");
  });

  it("should include metadata tag with correct structure", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
    });

    const result = formatStandupComment(data);
    const metadataMatch = result.match(
      /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/
    );

    expect(metadataMatch).not.toBeNull();
    const metadata = JSON.parse(metadataMatch![1]);
    expect(metadata.type).toBe("standup");
    expect(metadata.day).toBe(42);
    expect(metadata.date).toBe("2026-02-06");
    expect(metadata.repo).toBe("hivemoot/colony");
    expect(metadata.issueNumber).toBe(0);
  });

  it("should format direct commits section", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      directCommits: [
        { sha: "abc1234", message: "chore: fix typo in README", author: "admin" },
        { sha: "def5678", message: "ci: update workflow", author: "bot" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Direct pushes:");
    expect(result).toContain("`abc1234` chore: fix typo in README (@admin)");
    expect(result).toContain("`def5678` ci: update workflow (@bot)");
  });

  it("should truncate direct commits beyond 10 items", () => {
    const commits = Array.from({ length: 15 }, (_, i) => ({
      sha: `sha${String(i).padStart(4, "0")}`,
      message: `Commit ${i}`,
      author: "dev",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      directCommits: commits,
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Direct pushes:");
    expect(result).toContain("`sha0009` Commit 9");
    expect(result).not.toContain("`sha0010` Commit 10");
    expect(result).toContain("...and 5 more");
  });

  it("should format rejected issues section", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      recentlyRejected: [
        { number: 8, title: "Bad proposal" },
        { number: 9, title: "Out of scope idea" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Rejected");
    expect(result).toContain("#8 Bad proposal");
    expect(result).toContain("#9 Out of scope idea");
  });

  it("should show merge-ready status in activity table", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Impl A", author: "agent-1" },
      ],
      mergeReadyPRs: [
        { number: 10, title: "Impl A", author: "agent-1" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Implementation Activity");
    expect(result).toContain("Merge-ready");
  });

  it("should show stale status in activity table", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 15, title: "Old impl", author: "agent-2" },
      ],
      stalePRs: [
        { number: 15, title: "Old impl", author: "agent-2" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Implementation Activity");
    expect(result).toContain("Stale");
  });

  it("should deduplicate merge-ready PRs from implementation PRs in table", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Impl A", author: "agent-1" },
      ],
      mergeReadyPRs: [
        { number: 10, title: "Impl A", author: "agent-1" },
        { number: 20, title: "Extra MR", author: "agent-2" },
      ],
    });

    const result = formatStandupComment(data);

    // #10 appears once (from implementationPRs), #20 appended from mergeReadyPRs
    const matches = result.match(/#10/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain("#20");
  });

  it("should include needsAttention when LLM content has non-empty value", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature" }],
    });

    const llmContent: StandupLLMContent = {
      narrative: "Active colony day.",
      keyUpdates: ["New feature"],
      queensTake: {
        wentWell: "Quick reviews on all PRs.",
        focusAreas: "Need more testing.",
        needsAttention: "PR #5 has been stale for a week.",
      },
    };

    const result = formatStandupComment(data, llmContent);

    expect(result).toContain("Needs addressing:");
    expect(result).toContain("PR #5 has been stale for a week.");
  });

  it("should show current state with unknown issue count", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      // openIssueCount is undefined
    });

    const result = formatStandupComment(data);

    expect(result).toContain("? open issues");
  });

  it("should truncate report exceeding 60K char limit", () => {
    // Create a report that will be very long
    const manyPRs = Array.from({ length: 500 }, (_, i) => ({
      number: i + 1,
      title: "A".repeat(100),
      author: "agent",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: manyPRs,
      recentlyMergedPRs: manyPRs.slice(0, 8),
      directCommits: Array.from({ length: 10 }, (_, i) => ({
        sha: `sha${i}`,
        message: "B".repeat(100),
        author: "dev",
      })),
    });

    const result = formatStandupComment(data);

    expect(result.length).toBeLessThanOrEqual(60_000);
    expect(result).toContain("Colony Report");
    expect(result).toContain("truncated");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// LLM Reference Validation
// ───────────────────────────────────────────────────────────────────────────────

describe("validateLLMReferences", () => {
  it("should pass text with valid references", () => {
    const validNumbers = new Set([1, 5, 10]);
    const text = "Issue #1 was resolved via PR #5, while #10 remains open.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe(text);
  });

  it("should replace hallucinated references", () => {
    const validNumbers = new Set([1, 5]);
    const text = "Issue #1 and #999 were discussed.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe("Issue #1 and [ref removed] were discussed.");
  });

  it("should reject output when >50% references are hallucinated", () => {
    const validNumbers = new Set([1]);
    const text = "Issues #1, #99, #100, #200 were all active.";

    const result = validateLLMReferences(text, validNumbers);

    // 3 out of 4 refs are hallucinated (75%)
    expect(result).toBeNull();
  });

  it("should pass text with no references", () => {
    const validNumbers = new Set([1, 5]);
    const text = "The colony had a quiet day.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe(text);
  });

  it("should handle exactly 50% hallucinated refs (not rejected)", () => {
    const validNumbers = new Set([1, 2]);
    const text = "Issues #1, #2, #99, #100.";

    const result = validateLLMReferences(text, validNumbers);

    // 2 out of 4 = 50%, not >50%, so should sanitize not reject
    expect(result).toBe("Issues #1, #2, [ref removed], [ref removed].");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Health Signals
// ───────────────────────────────────────────────────────────────────────────────

describe("computeHealthSignals", () => {
  it("should detect merge-ready but unmerged PRs", () => {
    const data = createEmptyStandupData({
      mergeReadyPRs: [{ number: 10, title: "PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("merge-ready but unmerged")
    );
  });

  it("should detect stale PRs", () => {
    const data = createEmptyStandupData({
      stalePRs: [{ number: 20, title: "Old PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("stale PR")
    );
  });

  it("should detect large ready-to-implement backlog", () => {
    const data = createEmptyStandupData({
      readyToImplement: Array.from({ length: 6 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
      })),
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("ready-to-implement backlog")
    );
  });

  it("should detect ready issues with no implementation PRs", () => {
    const data = createEmptyStandupData({
      readyToImplement: [{ number: 1, title: "Ready" }],
      implementationPRs: [],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("no active implementation PRs")
    );
  });

  it("should return empty for healthy state", () => {
    const data = createEmptyStandupData({
      readyToImplement: [{ number: 1, title: "Ready" }],
      implementationPRs: [{ number: 10, title: "PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// hasAnyContent — remaining branches
// ───────────────────────────────────────────────────────────────────────────────

describe("hasAnyContent — additional branches", () => {
  it("should return true when there are merge-ready PRs", () => {
    const data = createEmptyStandupData({
      mergeReadyPRs: [{ number: 10, title: "PR", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are stale PRs", () => {
    const data = createEmptyStandupData({
      stalePRs: [{ number: 20, title: "Old", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are recently rejected issues", () => {
    const data = createEmptyStandupData({
      recentlyRejected: [{ number: 3, title: "Rejected" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// buildStandupUserPrompt
// ───────────────────────────────────────────────────────────────────────────────

describe("buildStandupUserPrompt", () => {
  it("should include repo name, day number, and report date", () => {
    const data = createEmptyStandupData();
    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("hivemoot/colony");
    expect(prompt).toContain("Day 42");
    expect(prompt).toContain("2026-02-06");
  });

  it("should list pipeline issues with numbers and titles", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature A" }],
      votingPhase: [{ number: 2, title: "Feature B" }],
      extendedVoting: [{ number: 3, title: "Feature C" }],
      readyToImplement: [{ number: 4, title: "Feature D" }],
    });

    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("Discussion phase: 1 issues");
    expect(prompt).toContain('#1 "Feature A"');
    expect(prompt).toContain("Voting phase: 1 issues");
    expect(prompt).toContain('#2 "Feature B"');
    expect(prompt).toContain("Extended voting: 1 issues");
    expect(prompt).toContain('#3 "Feature C"');
    expect(prompt).toContain("Ready to implement: 1 issues");
    expect(prompt).toContain('#4 "Feature D"');
  });

  it("should include implementation PR sections when present", () => {
    const data = createEmptyStandupData({
      implementationPRs: [{ number: 10, title: "Impl X", author: "worker" }],
      mergeReadyPRs: [{ number: 20, title: "Ready PR", author: "polisher" }],
      stalePRs: [{ number: 30, title: "Stale PR", author: "scout" }],
    });

    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("## Active Implementation PRs");
    expect(prompt).toContain('#10 "Impl X" by @worker');
    expect(prompt).toContain("## Merge-Ready PRs");
    expect(prompt).toContain('#20 "Ready PR" by @polisher');
    expect(prompt).toContain("## Stale PRs");
    expect(prompt).toContain('#30 "Stale PR" by @scout');
  });

  it("should include merged and rejected sections when present", () => {
    const data = createEmptyStandupData({
      recentlyMergedPRs: [{ number: 40, title: "Merged PR", author: "dev" }],
      recentlyRejected: [{ number: 50, title: "Rejected issue" }],
    });

    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("## Merged Today");
    expect(prompt).toContain('#40 "Merged PR" by @dev');
    expect(prompt).toContain("## Rejected Today");
    expect(prompt).toContain('#50 "Rejected issue"');
  });

  it("should include health signals with attention marker", () => {
    const data = createEmptyStandupData({
      healthSignals: ["3 stale PRs approaching auto-close: #10, #11, #12"],
    });

    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("## Health Signals");
    expect(prompt).toContain("REQUIRES ATTENTION IN REPORT");
    expect(prompt).toContain("3 stale PRs approaching auto-close");
  });

  it("should omit optional sections when data is absent", () => {
    const data = createEmptyStandupData();
    const prompt = buildStandupUserPrompt(data);

    expect(prompt).not.toContain("## Active Implementation PRs");
    expect(prompt).not.toContain("## Merge-Ready PRs");
    expect(prompt).not.toContain("## Stale PRs");
    expect(prompt).not.toContain("## Merged Today");
    expect(prompt).not.toContain("## Rejected Today");
    expect(prompt).not.toContain("## Health Signals");
  });

  it("should end with instruction to use only listed numbers", () => {
    const data = createEmptyStandupData();
    const prompt = buildStandupUserPrompt(data);

    expect(prompt).toContain("Only reference issue/PR numbers listed above");
  });
});
