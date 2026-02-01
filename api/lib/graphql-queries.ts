/**
 * GraphQL Queries for PR-Issue Linking
 *
 * Uses GitHub's GraphQL API to efficiently query PR-issue relationships.
 * This is preferred over parsing PR body text because GitHub's native
 * linking (via "fixes #123" keywords) is more reliable and handles
 * cross-repo references automatically.
 */

import type { LinkedIssue, PullRequest } from "./types.js";

/**
 * GraphQL client interface - minimal subset needed for our queries.
 * Both Probot's octokit and @octokit/rest's graphql method satisfy this.
 */
export interface GraphQLClient {
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

// ───────────────────────────────────────────────────────────────────────────────
// Query: Get issues that will be closed when a PR merges
// ───────────────────────────────────────────────────────────────────────────────

// Intentionally limited to 10 issues. PRs fixing >10 issues are rare and
// likely indicate a problem (e.g., mass-closing spam). No pagination needed.
const GET_LINKED_ISSUES_QUERY = `
  query getLinkedIssues($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        closingIssuesReferences(first: 10) {
          nodes {
            number
            title
            state
            labels(first: 20) {
              nodes {
                name
              }
            }
          }
        }
      }
    }
  }
`;

interface LinkedIssuesResponse {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: LinkedIssue[];
      };
    } | null;
  };
}

/**
 * Get issues that will be closed when a PR is merged.
 * Uses GitHub's closingIssuesReferences which parses "fixes #123" etc.
 */
export async function getLinkedIssues(
  client: GraphQLClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<LinkedIssue[]> {
  const response = await client.graphql<LinkedIssuesResponse>(
    GET_LINKED_ISSUES_QUERY,
    { owner, repo, pr: prNumber }
  );

  return response.repository.pullRequest?.closingIssuesReferences.nodes ?? [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Query: Get open PRs that link to an issue (reverse lookup)
// ───────────────────────────────────────────────────────────────────────────────

const GET_OPEN_PRS_FOR_ISSUE_QUERY = `
  query getOpenPRsForIssue($owner: String!, $repo: String!, $issue: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issue) {
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  title
                  state
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface CrossReferencedEvent {
  source: {
    number?: number;
    title?: string;
    state?: "OPEN" | "CLOSED" | "MERGED";
    author?: {
      login: string;
    };
  } | null;
}

interface OpenPRsForIssueResponse {
  repository: {
    issue: {
      timelineItems: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: CrossReferencedEvent[];
      };
    } | null;
  };
}

/**
 * Maximum number of PRs to fetch for an issue.
 * Also used as a cap on cross-reference events scanned to avoid unbounded pagination
 * when the same PR appears many times in the timeline.
 *
 * In practice, governance limits PRs per issue, so this is a safety net.
 */
const MAX_PRS_TO_FETCH = 100;

/**
 * Type guard for valid open PR sources from cross-referenced events.
 * Validates required fields (number, state=OPEN) but allows missing author
 * to handle PRs from deleted GitHub accounts.
 */
function isValidOpenPRSource(
  source: CrossReferencedEvent["source"]
): source is {
  number: number;
  title?: string;
  state: "OPEN";
  author?: { login: string };
} {
  return (
    source !== null &&
    typeof source.number === "number" &&
    source.state === "OPEN"
  );
}

/**
 * Get all open PRs that reference an issue.
 * Filters to only return OPEN PRs (not closed/merged).
 * Uses cursor-based pagination with safety limit to prevent unbounded fetching.
 *
 * Deduplicates by PR number since a PR can create multiple cross-reference
 * events (via body, commits, edits, etc.).
 *
 * Handles deleted GitHub accounts by using "ghost" as the author login
 * (matching GitHub's web UI convention).
 */
export async function getOpenPRsForIssue(
  client: GraphQLClient,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<PullRequest[]> {
  // Use Map for deduplication - same PR can appear in multiple cross-reference events
  const prMap = new Map<number, PullRequest>();
  let cursor: string | null = null;
  let hasNextPage = true;
  let eventsScanned = 0;

  while (hasNextPage && prMap.size < MAX_PRS_TO_FETCH && eventsScanned < MAX_PRS_TO_FETCH) {
    const response: OpenPRsForIssueResponse = await client.graphql<OpenPRsForIssueResponse>(
      GET_OPEN_PRS_FOR_ISSUE_QUERY,
      { owner, repo, issue: issueNumber, after: cursor }
    );

    const issue = response.repository.issue;
    if (!issue) {
      return [];
    }

    const timelineItems = issue.timelineItems.nodes;
    eventsScanned += timelineItems.length;

    // Filter to PRs that are open and have the expected structure
    // Uses "ghost" for deleted authors (matching GitHub's web UI convention)
    const openPRs = timelineItems
      .map((event: CrossReferencedEvent) => event.source)
      .filter(isValidOpenPRSource)
      .map((source) => ({
        number: source.number,
        title: source.title ?? "",
        state: source.state,
        author: {
          login: source.author?.login || "ghost",
        },
      }));

    // Add to map, deduplicating by PR number
    for (const pr of openPRs) {
      if (!prMap.has(pr.number)) {
        prMap.set(pr.number, pr);
      }
    }

    if (eventsScanned >= MAX_PRS_TO_FETCH) {
      break;
    }

    hasNextPage = issue.timelineItems.pageInfo.hasNextPage;
    cursor = issue.timelineItems.pageInfo.endCursor;

    // Safety check: if endCursor is null but hasNextPage is true, stop to avoid infinite loop
    if (hasNextPage && cursor === null) {
      break;
    }
  }

  return Array.from(prMap.values());
}
