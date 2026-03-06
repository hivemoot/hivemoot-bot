/**
 * GraphQL Queries for PR-Issue Linking
 *
 * Uses GitHub's GraphQL API to efficiently query PR-issue relationships.
 * This is preferred over parsing PR body text because GitHub's native
 * linking (via "fixes #123" keywords) is more reliable and handles
 * cross-repo references automatically.
 */

import type { LinkedIssue, PullRequest } from "./types.js";
import { logger } from "./logger.js";

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
        nodes: Array<LinkedIssue | null>;
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

  return (
    response.repository.pullRequest?.closingIssuesReferences.nodes.filter(
      (node): node is LinkedIssue => node !== null
    ) ?? []
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Query: Get PR body last-edited timestamp
// ───────────────────────────────────────────────────────────────────────────────

const GET_PR_BODY_LAST_EDITED_QUERY = `
  query getPRBodyLastEdited($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        lastEditedAt
      }
    }
  }
`;

interface PRBodyLastEditedResponse {
  repository: {
    pullRequest: {
      lastEditedAt: string | null;
    } | null;
  };
}

/**
 * Get when a PR body was last edited, or null if never edited.
 *
 * Uses GitHub's GraphQL `lastEditedAt` field which tracks body edits
 * specifically (unlike `updatedAt` which changes on any activity).
 * Enables the reconciler to detect description edits without relying
 * on the real-time pull_request.edited webhook.
 */
export async function getPRBodyLastEditedAt(
  client: GraphQLClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Date | null> {
  const response = await client.graphql<PRBodyLastEditedResponse>(
    GET_PR_BODY_LAST_EDITED_QUERY,
    { owner, repo, pr: prNumber }
  );

  const lastEditedAt = response.repository.pullRequest?.lastEditedAt;
  if (!lastEditedAt) return null;

  const date = new Date(lastEditedAt);
  if (isNaN(date.getTime())) {
    logger.warn(`Invalid lastEditedAt timestamp from GitHub GraphQL: "${lastEditedAt}"`);
    return null;
  }
  return date;
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
                  repository {
                    owner {
                      login
                    }
                    name
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
    repository?: {
      owner: {
        login: string;
      };
      name: string;
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
        nodes: Array<CrossReferencedEvent | null>;
      };
    } | null;
  };
}

/**
 * Pattern for GitHub GraphQL errors indicating a stale or deleted PR.
 * These are expected when cross-references point to PRs that no longer exist
 * (e.g., force-deleted branches, renumbered PRs after repo transfer).
 * Classified as noise rather than systemic failures.
 */
const STALE_CANDIDATE_PATTERN = /Could not resolve to a PullRequest with the number/;

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
 * Get all open PRs that properly close an issue (via "Fixes #N" / "Closes #N").
 *
 * Uses a two-step approach:
 * 1. Find candidate PRs via CROSS_REFERENCED_EVENT (efficient - only PRs that mention the issue)
 * 2. Verify each candidate actually uses closing syntax via closingIssuesReferences
 *
 * This ensures consistency with processImplementationIntake which uses closingIssuesReferences.
 * PRs that merely mention an issue (e.g., "see #123") are excluded.
 *
 * Deduplicates by PR number since a PR can create multiple cross-reference events.
 * Handles deleted GitHub accounts by using "ghost" as the author login.
 */
export async function getOpenPRsForIssue(
  client: GraphQLClient,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<PullRequest[]> {
  // Step 1: Get candidate PRs via cross-references
  const candidates = await getCrossReferencedOpenPRs(client, owner, repo, issueNumber);

  if (candidates.length === 0) {
    return [];
  }

  // Step 2: Verify each candidate actually closes this issue.
  // Uses bounded parallelism to reduce latency (important in webhook context).
  // Per-PR errors are caught so one transient failure doesn't lose all results.
  const BATCH_SIZE = 5;
  const verified: PullRequest[] = [];
  let staleCandidateCount = 0;
  let hardFailureCount = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (pr) => {
        const linkedIssues = await getLinkedIssues(client, owner, repo, pr.number);
        return linkedIssues.some((issue) => issue.number === issueNumber) ? pr : null;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== null) {
        verified.push(result.value);
      } else if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (STALE_CANDIDATE_PATTERN.test(reason)) {
          // Stale/deleted PR cross-reference — expected noise, not a systemic failure.
          staleCandidateCount++;
          logger.debug(
            `Skipped stale candidate PR in ${owner}/${repo} ` +
            `(issue #${issueNumber}): ${reason}`
          );
        } else {
          hardFailureCount++;
          logger.warn(
            `Failed to verify closing syntax for candidate PR in ${owner}/${repo} ` +
            `(issue #${issueNumber}): ${reason}`
          );
        }
      }
    }
  }

  if (staleCandidateCount > 0) {
    logger.info(
      `Skipped ${staleCandidateCount} stale candidate(s) for ${owner}/${repo}#${issueNumber}`
    );
  }

  // Fail-closed only on non-stale systemic failures (rate limit, auth, outage).
  // Stale candidates are expected noise and do not trigger fail-closed.
  if (hardFailureCount > 0 && verified.length === 0) {
    throw new Error(
      `All ${hardFailureCount} PR closing-syntax verification(s) failed for ` +
      `${owner}/${repo}#${issueNumber}. Cannot determine linked PRs.`
    );
  }

  return verified;
}

/**
 * Internal helper: Get open PRs that cross-reference an issue.
 * This is the first step of getOpenPRsForIssue - finds candidates that mention the issue.
 */
async function getCrossReferencedOpenPRs(
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

    // Layer 1: Null safety — GitHub GraphQL can return null entries in sparse arrays.
    // Layer 2: Cross-repo filtering — drop candidates from other repositories.
    // Layer 3: State + number filtering (existing) — only OPEN PRs with valid numbers.
    // Uses "ghost" for deleted authors (matching GitHub's web UI convention).
    const openPRs = timelineItems
      .filter((event): event is CrossReferencedEvent => event !== null)
      .filter((event) => {
        // Drop candidates from other repositories to avoid querying
        // local repo for non-existent PR numbers.
        const sourceRepo = event.source?.repository;
        if (sourceRepo) {
          return (
            sourceRepo.owner.login.toLowerCase() === owner.toLowerCase() &&
            sourceRepo.name.toLowerCase() === repo.toLowerCase()
          );
        }
        // If repository field is missing (shouldn't happen with our query,
        // but defensive), allow through for verification step to handle.
        return true;
      })
      .map((event) => event.source)
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
