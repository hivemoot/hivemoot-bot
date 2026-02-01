import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLinkedIssues,
  getOpenPRsForIssue,
  type GraphQLClient,
} from "./graphql-queries.js";

/**
 * Tests for GraphQL Queries
 *
 * These tests verify the PR-issue linking queries:
 * - getLinkedIssues: Issues that will be closed when a PR merges
 * - getOpenPRsForIssue: Open PRs referencing an issue (reverse lookup)
 */

describe("getLinkedIssues", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    };
  });

  it("should return linked issues from closingIssuesReferences", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                number: 123,
                title: "Fix bug",
                state: "OPEN",
                labels: { nodes: [{ name: "bug" }] },
              },
              {
                number: 456,
                title: "Add feature",
                state: "OPEN",
                labels: { nodes: [{ name: "enhancement" }] },
              },
            ],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result).toEqual([
      {
        number: 123,
        title: "Fix bug",
        state: "OPEN",
        labels: { nodes: [{ name: "bug" }] },
      },
      {
        number: 456,
        title: "Add feature",
        state: "OPEN",
        labels: { nodes: [{ name: "enhancement" }] },
      },
    ]);
  });

  it("should return empty array when PR not found (null)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: null,
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 9999);

    expect(result).toEqual([]);
  });

  it("should return empty array when no linked issues", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result).toEqual([]);
  });

  it("should pass correct query variables", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: { nodes: [] },
        },
      },
    });

    await getLinkedIssues(mockClient, "test-owner", "test-repo", 123);

    expect(mockClient.graphql).toHaveBeenCalledWith(
      expect.stringContaining("getLinkedIssues"),
      { owner: "test-owner", repo: "test-repo", pr: 123 }
    );
  });

  it("should handle issues with multiple labels", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                number: 1,
                title: "Complex issue",
                state: "OPEN",
                labels: {
                  nodes: [
                    { name: "bug" },
                    { name: "priority-high" },
                    { name: "needs-review" },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result[0].labels.nodes).toHaveLength(3);
  });
});

describe("getOpenPRsForIssue", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    };
  });

  it("should filter to only OPEN PRs", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              { source: { number: 2, title: "PR 2", state: "CLOSED", author: { login: "user2" } } },
              { source: { number: 3, title: "PR 3", state: "MERGED", author: { login: "user3" } } },
              { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });

  it("should filter out events without PR number", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              { source: { title: "No number", state: "OPEN", author: { login: "user2" } } },
              { source: { number: undefined, title: "Undefined", state: "OPEN", author: { login: "user3" } } },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should use 'ghost' for PRs with missing or undefined author", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              { source: { number: 2, title: "PR 2", state: "OPEN", author: undefined } },
              { source: { number: 3, title: "PR 3", state: "OPEN" } }, // No author property
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } });
    expect(result[1]).toEqual({ number: 2, title: "PR 2", state: "OPEN", author: { login: "ghost" } });
    expect(result[2]).toEqual({ number: 3, title: "PR 3", state: "OPEN", author: { login: "ghost" } });
  });

  it("should use 'ghost' for PRs with null author (deleted GitHub account)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: { number: 1, title: "PR from deleted user", state: "OPEN", author: null } },
              { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "active-user" } } },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result[0].author.login).toBe("ghost");
    expect(result[1].author.login).toBe("active-user");
  });

  it("should deduplicate PRs that appear in multiple cross-reference events", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              // Same PR appears twice (e.g., mentioned in body and commit)
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
              // PR 1 appears a third time
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it("should deduplicate PRs across pagination pages", async () => {
    vi.mocked(mockClient.graphql)
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: [
                { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                // PR 1 appears again on second page
                { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                { source: { number: 3, title: "PR 3", state: "OPEN", author: { login: "user3" } } },
              ],
            },
          },
        },
      });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(3);
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3]);
  });

  it("should stop pagination after scanning the safety event cap", async () => {
    const nodes = Array.from({ length: 100 }, () => ({
      source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } },
    }));

    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: true, endCursor: "cursor1" },
            nodes,
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(mockClient.graphql).toHaveBeenCalledTimes(1);
  });

  it("should return empty array when issue not found (null)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: null,
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 9999);

    expect(result).toEqual([]);
  });

  it("should return empty array when no timeline items", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([]);
  });

  it("should filter out events with null source", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: null },
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
  });

  it("should transform response correctly", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                source: {
                  number: 42,
                  title: "Add new feature",
                  state: "OPEN",
                  author: { login: "developer" },
                },
              },
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([
      {
        number: 42,
        title: "Add new feature",
        state: "OPEN",
        author: { login: "developer" },
      },
    ]);
  });

  it("should handle missing title gracefully", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { source: { number: 1, state: "OPEN", author: { login: "user1" } } }, // No title
            ],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result[0].title).toBe("");
  });

  it("should pass correct query variables with null cursor on first request", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    });

    await getOpenPRsForIssue(mockClient, "test-owner", "test-repo", 456);

    expect(mockClient.graphql).toHaveBeenCalledWith(
      expect.stringContaining("getOpenPRsForIssue"),
      { owner: "test-owner", repo: "test-repo", issue: 456, after: null }
    );
  });

  it("should paginate through multiple pages of results", async () => {
    vi.mocked(mockClient.graphql)
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: [
                { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "cursor2" },
              nodes: [
                { source: { number: 3, title: "PR 3", state: "OPEN", author: { login: "user3" } } },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
              ],
            },
          },
        },
      });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(4);
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3, 4]);
    expect(mockClient.graphql).toHaveBeenCalledTimes(3);
  });

  it("should pass cursor to subsequent pagination requests", async () => {
    vi.mocked(mockClient.graphql)
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "abc123" },
              nodes: [
                { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });

    await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // First call should have null cursor
    expect(mockClient.graphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("getOpenPRsForIssue"),
      { owner: "owner", repo: "repo", issue: 123, after: null }
    );

    // Second call should use the endCursor from first response
    expect(mockClient.graphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("getOpenPRsForIssue"),
      { owner: "owner", repo: "repo", issue: 123, after: "abc123" }
    );
  });

  it("should stop pagination when hasNextPage is false", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: "some-cursor" },
            nodes: [
              { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
            ],
          },
        },
      },
    });

    await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(mockClient.graphql).toHaveBeenCalledTimes(1);
  });

  it("should filter across pages and only return OPEN PRs", async () => {
    vi.mocked(mockClient.graphql)
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: [
                { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                { source: { number: 2, title: "PR 2", state: "CLOSED", author: { login: "user2" } } },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { source: { number: 3, title: "PR 3", state: "MERGED", author: { login: "user3" } } },
                { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
              ],
            },
          },
        },
      });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });
});
