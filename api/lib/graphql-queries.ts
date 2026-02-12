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
                    name
                    owner {
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
      name?: string;
      owner?: {
        login?: string;
      };
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
  repository?: {
    name?: string;
    owner?: {
      login?: string;
    };
  };
} {
  return (
    source !== null &&
    typeof source.number === "number" &&
    source.state === "OPEN"
  );
}

function isNotFoundPRVerificationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Could not resolve to a PullRequest with the number of \d+/i.test(error.message);
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
  const {
    prs: candidates,
    crossRepoCandidateSkipped,
  } = await getCrossReferencedOpenPRs(client, owner, repo, issueNumber);

  if (candidates.length === 0) {
    logger.debug(
      `PR reconciliation stats for ${owner}/${repo}#${issueNumber}: ` +
      `crossRepoCandidateSkipped=${crossRepoCandidateSkipped} ` +
      `staleCandidateSkipped=0 verificationHardFailure=0 ` +
      `candidates=0 verified=0`
    );
    return [];
  }

  // Step 2: Verify each candidate actually closes this issue.
  // Uses bounded parallelism to reduce latency (important in webhook context).
  // Per-PR errors are caught so one transient failure doesn't lose all results.
  const BATCH_SIZE = 5;
  const verified: PullRequest[] = [];
  let verificationHardFailure = 0;
  let staleCandidateSkipped = 0;

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
        if (isNotFoundPRVerificationError(result.reason)) {
          staleCandidateSkipped++;
          logger.debug(
            `Skipping stale PR candidate during closing-syntax verification in ${owner}/${repo} ` +
            `(issue #${issueNumber}): ${reason}`
          );
        } else {
          verificationHardFailure++;
          logger.warn(
            `Failed to verify closing syntax for candidate PR in ${owner}/${repo} ` +
            `(issue #${issueNumber}): ${reason}`
          );
        }
      }
    }
  }

  logger.debug(
    `PR reconciliation stats for ${owner}/${repo}#${issueNumber}: ` +
    `crossRepoCandidateSkipped=${crossRepoCandidateSkipped} ` +
    `staleCandidateSkipped=${staleCandidateSkipped} ` +
    `verificationHardFailure=${verificationHardFailure} ` +
    `candidates=${candidates.length} verified=${verified.length}`
  );

  // If every verification failed, this is likely a systemic issue (rate limit,
  // auth failure, outage) — not a per-PR transient error. Throw so callers
  // (especially webhook handlers that don't retry) don't silently proceed
  // with an empty result that looks like "no PRs close this issue."
  if (verificationHardFailure > 0 && verified.length === 0) {
    throw new Error(
      `All ${verificationHardFailure} PR closing-syntax verification(s) failed for ` +
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
): Promise<{ prs: PullRequest[]; crossRepoCandidateSkipped: number }> {
  // Use Map for deduplication - same PR can appear in multiple cross-reference events
  const prMap = new Map<number, PullRequest>();
  let crossRepoCandidateSkipped = 0;
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
      return { prs: [], crossRepoCandidateSkipped };
    }

    const timelineItems = issue.timelineItems.nodes;
    eventsScanned += timelineItems.length;

    // Filter to PRs that are open and have the expected structure
    // Uses "ghost" for deleted authors (matching GitHub's web UI convention)
    const openPRs = timelineItems
      .map((event: CrossReferencedEvent) => event.source)
      .filter(isValidOpenPRSource)
      .filter((source) => {
        const sourceOwner = source.repository?.owner?.login?.toLowerCase();
        const sourceRepo = source.repository?.name?.toLowerCase();
        if (!sourceOwner || !sourceRepo) {
          return true;
        }
        const sameRepo = sourceOwner === owner.toLowerCase() && sourceRepo === repo.toLowerCase();
        if (!sameRepo) {
          crossRepoCandidateSkipped++;
        }
        return sameRepo;
      })
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

  return { prs: Array.from(prMap.values()), crossRepoCandidateSkipped };
}
