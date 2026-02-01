/**
 * Scheduled Discussion/Voting Phase Closer
 *
 * This script runs on a schedule (via GitHub Actions) to automatically
 * transition issues through governance phases:
 *
 * 1. Discussion phase → Voting phase (after DISCUSSION_DURATION_MS)
 * 2. Voting phase → Closed/Decided (after VOTING_DURATION_MS)
 *
 * It authenticates as a GitHub App and processes all installations.
 */

import { Octokit } from "octokit";
import * as core from "@actions/core";
import { LABELS, PR_MESSAGES } from "../api/config.js";
import {
  createIssueOperations,
  createPROperations,
  createGovernanceService,
  getOpenPRsForIssue,
  loadRepositoryConfig,
  logger,
} from "../api/lib/index.js";
import { NOTIFICATION_TYPES } from "../api/lib/bot-comments.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository, Issue, IssueRef, EffectiveConfig, VotingOutcome } from "../api/lib/index.js";
import type { IssueOperations } from "../api/lib/github-client.js";
import type { GovernanceService } from "../api/lib/governance.js";

/**
 * Represents an issue that was skipped due to missing voting comment.
 * Human intervention has been requested for these issues.
 */
interface SkippedIssue {
  repo: string;
  issueNumber: number;
}

type AccessIssueReason = "rate_limit" | "forbidden";

interface AccessIssue {
  repo: string;
  issueNumber: number;
  status?: number;
  reason: AccessIssueReason;
}

// ───────────────────────────────────────────────────────────────────────────────
// Retry Utility
// ───────────────────────────────────────────────────────────────────────────────

interface RetryableError {
  status?: number;
  code?: string;
  message?: string;
  response?: {
    headers?: Record<string, string | number | undefined>;
  };
}

/**
 * Check if an error is retryable (transient network/API issues)
 */
export function isRetryableError(error: unknown): boolean {
  const err = error as RetryableError;
  // Retry on server errors, rate limits, and network timeouts
  return (
    err.status === 502 ||
    err.status === 503 ||
    err.status === 504 ||
    isRateLimitError(error) ||
    err.code === "ETIMEDOUT" ||
    err.code === "ECONNRESET"
  );
}

function getHeaderValue(
  headers: Record<string, string | number | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) {
      return String(value);
    }
  }
  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  const err = error as RetryableError;
  if (err.status !== 403 && err.status !== 429) {
    return false;
  }
  const remaining = getHeaderValue(err.response?.headers, "x-ratelimit-remaining");
  const retryAfter = getHeaderValue(err.response?.headers, "retry-after");
  if (remaining === "0" || retryAfter) {
    return true;
  }
  const message = err.message?.toLowerCase() ?? "";
  return message.includes("rate limit");
}

/**
 * Execute a function with exponential backoff retry for transient errors
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      logger.warn(
        `Attempt ${attempt} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// ───────────────────────────────────────────────────────────────────────────────
// Issue Processing
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Check if an error indicates the issue was deleted
 */
function isNotFound(error: unknown): boolean {
  const status = (error as RetryableError).status;
  return status === 404 || status === 410;
}

/**
 * Process phase transitions for a single issue
 */
async function processIssuePhase(
  issues: IssueOperations,
  governance: GovernanceService,
  ref: IssueRef,
  labelName: string,
  durationMs: number,
  phaseName: string,
  transitionFn: () => Promise<unknown>,
  onAccessIssue?: (ref: IssueRef, status: number | undefined, reason: AccessIssueReason) => void
): Promise<void> {
  try {
    const labeledAt = await withRetry(() =>
      issues.getLabelAddedTime(ref, labelName)
    );

    if (!labeledAt) {
      logger.warn(
        `Issue #${ref.issueNumber}: Could not determine when '${labelName}' label was added`
      );
      return;
    }

    const elapsed = Date.now() - labeledAt.getTime();
    if (elapsed >= durationMs) {
      logger.info(`Transitioning #${ref.issueNumber} out of ${phaseName} phase`);
      await withRetry(transitionFn);
    } else {
      // Use floor for conservative remaining time estimate
      const remainingMs = durationMs - elapsed;
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
      logger.debug(
        `Issue #${ref.issueNumber}: ${remainingMinutes}m ${remainingSeconds}s remaining in ${phaseName}`
      );
    }
  } catch (error) {
    // Handle deleted issues gracefully
    if (isNotFound(error)) {
      logger.warn(
        `Issue #${ref.issueNumber} not found (may have been deleted). Skipping.`
      );
      return;
    }
    const status = (error as RetryableError).status;
    if (isRateLimitError(error) || status === 429) {
      logger.warn(`Issue #${ref.issueNumber} rate limited. Skipping for now.`);
      onAccessIssue?.(ref, status, "rate_limit");
      return;
    }
    if (status === 403) {
      logger.warn(
        `Issue #${ref.issueNumber} forbidden or missing permissions. Skipping.`
      );
      onAccessIssue?.(ref, status, "forbidden");
      return;
    }
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// PR Notification
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Notify existing PRs that a linked issue has passed voting.
 *
 * Intentionally notification-only — does NOT auto-tag PRs with the
 * `implementation` label. PR authors must push a new commit after
 * voting passes to activate their PR. This prevents gaming where an
 * agent pre-creates an empty PR during discussion/voting to auto-claim
 * an implementation slot when voting passes.
 *
 * The activation date guard (isActivationAfterReady) in the webhook
 * handler enforces this: PR activity must occur after the ready label
 * was added. See processImplementationIntake in api/github/webhooks/index.ts.
 */
export async function notifyPendingPRs(
  octokit: InstanceType<typeof Octokit>,
  appId: number,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  try {
    const prs = createPROperations(octokit, { appId });
    const linkedPRs = await getOpenPRsForIssue(octokit, owner, repo, issueNumber);

    if (linkedPRs.length === 0) {
      logger.debug(`No open PRs linked to issue #${issueNumber}`);
      return;
    }

    // Skip PRs already labeled as implementation
    const implementationPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
    const implementationPRNumbers = new Set(implementationPRs.map((pr) => pr.number));

    for (const linkedPR of linkedPRs) {
      if (implementationPRNumbers.has(linkedPR.number)) {
        continue;
      }

      const ref = { owner, repo, prNumber: linkedPR.number };
      const alreadyNotified = await prs.hasNotificationComment(
        ref,
        NOTIFICATION_TYPES.VOTING_PASSED,
        issueNumber
      );
      if (alreadyNotified) {
        logger.debug(`PR #${linkedPR.number} already notified for issue #${issueNumber}`);
        continue;
      }

      await prs.comment(
        ref,
        PR_MESSAGES.issueVotingPassed(issueNumber, linkedPR.author.login)
      );
      logger.info(`Notified PR #${linkedPR.number} (@${linkedPR.author.login}) that issue #${issueNumber} is ready`);
    }
  } catch (error) {
    // Best-effort: don't fail governance transition if notification fails
    logger.warn(
      `Failed to notify PRs for issue #${issueNumber}: ${(error as Error).message}`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Repository Processing
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a single governance phase to process.
 * Each phase has a label filter, duration, display name, and transition logic.
 */
interface PhaseConfig {
  label: string;
  durationMs: number;
  phaseName: string;
  transition: (governance: GovernanceService, ref: IssueRef) => Promise<unknown>;
}

/**
 * Paginate through issues with a given label and process each through
 * the phase transition pipeline. Skips pull requests (the issues API
 * returns both issues and PRs).
 */
async function processPhaseIssues(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repoName: string,
  issues: IssueOperations,
  governance: GovernanceService,
  phase: PhaseConfig,
  onAccessIssue: (ref: IssueRef, status: number | undefined, reason: AccessIssueReason) => void
): Promise<void> {
  const iterator = octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      owner,
      repo: repoName,
      state: "open",
      labels: phase.label,
      per_page: 100,
    }
  );

  for await (const { data: page } of iterator) {
    for (const issue of page as Issue[]) {
      if ('pull_request' in issue) {
        continue;
      }
      const ref: IssueRef = { owner, repo: repoName, issueNumber: issue.number };
      await processIssuePhase(
        issues,
        governance,
        ref,
        phase.label,
        phase.durationMs,
        phase.phaseName,
        () => phase.transition(governance, ref),
        onAccessIssue
      );
    }
  }
}

/**
 * Process a single repository - find issues in discussion/voting phase
 * and transition them if the time threshold has passed.
 *
 * Uses pagination to handle repositories with >100 issues per phase.
 * Loads per-repo config from .github/hivemoot.yml if present.
 *
 * @returns Skipped and access issues encountered during processing.
 */
async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  appId: number
): Promise<{ skippedIssues: SkippedIssue[]; accessIssues: AccessIssue[] }> {
  const owner = repo.owner.login;
  const repoName = repo.name;
  const skippedIssues: SkippedIssue[] = [];
  const accessIssues: AccessIssue[] = [];

  logger.group(`Processing ${repo.full_name}`);

  try {
    // Load per-repo configuration (falls back to defaults if not present)
    const repoConfig: EffectiveConfig = await loadRepositoryConfig(octokit, owner, repoName);

    const issues = createIssueOperations(octokit, { appId });
    const governance = createGovernanceService(issues);

    const trackOutcome = (outcome: VotingOutcome, issueNumber: number) => {
      if (outcome === "skipped") {
        skippedIssues.push({ repo: repo.full_name, issueNumber });
      }
      logger.info(`Outcome for #${issueNumber}: ${outcome}`);
    };
    const trackAccessIssue = (
      ref: IssueRef,
      status: number | undefined,
      reason: AccessIssueReason
    ) => {
      accessIssues.push({ repo: repo.full_name, issueNumber: ref.issueNumber, status, reason });
    };

    // Voting/inconclusive phases share a transition pattern: end voting, track
    // outcome, and notify pending PRs if the proposal passed.
    const votingTransition = (
      endFn: (ref: IssueRef) => Promise<VotingOutcome>
    ) => async (_gov: GovernanceService, ref: IssueRef): Promise<void> => {
      const outcome = await endFn(ref);
      trackOutcome(outcome, ref.issueNumber);
      if (outcome === "phase:ready-to-implement") {
        await notifyPendingPRs(octokit, appId, owner, repoName, ref.issueNumber);
      }
    };

    const phases: PhaseConfig[] = [
      {
        label: LABELS.DISCUSSION,
        durationMs: repoConfig.governance.discussionDurationMs,
        phaseName: "discussion",
        transition: (_gov, ref) => governance.transitionToVoting(ref),
      },
      {
        label: LABELS.VOTING,
        durationMs: repoConfig.governance.votingDurationMs,
        phaseName: "voting",
        transition: votingTransition((ref) => governance.endVoting(ref)),
      },
      {
        label: LABELS.INCONCLUSIVE,
        durationMs: repoConfig.governance.votingDurationMs,
        phaseName: "extended voting",
        transition: votingTransition((ref) => governance.resolveInconclusive(ref)),
      },
    ];

    for (const phase of phases) {
      await processPhaseIssues(
        octokit, owner, repoName, issues, governance, phase, trackAccessIssue
      );
    }

    return { skippedIssues, accessIssues };
  } finally {
    logger.groupEnd();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point - processes all installations and their repositories.
 *
 * Uses the shared runner for installation/repo iteration.
 * The afterAll hook handles aggregate reporting for skipped and access issues.
 */
async function main(): Promise<void> {
  await runForAllRepositories<{ skippedIssues: SkippedIssue[]; accessIssues: AccessIssue[] }>({
    scriptName: "scheduled discussion/voting phase closer",
    startMessage: "Per-repo config loaded from .github/hivemoot.yml (defaults: 24h discussion, 24h voting)",
    processRepository,
    afterAll: ({ results }) => {
      const allSkippedIssues = results.flatMap((r) => r.result.skippedIssues);
      const allAccessIssues = results.flatMap((r) => r.result.accessIssues);

      if (allSkippedIssues.length > 0) {
        const skippedList = allSkippedIssues
          .map((s) => `${s.repo}#${s.issueNumber}`)
          .join(", ");
        logger.warn(
          `${allSkippedIssues.length} issue(s) skipped due to missing voting comments: ${skippedList}`
        );
        logger.warn("Human intervention requested for these issues (see blocked:human-help-needed label)");
        core.warning(`${allSkippedIssues.length} issue(s) require human intervention`);
      }

      if (allAccessIssues.length > 0) {
        const rateLimited = allAccessIssues.filter((issue) => issue.reason === "rate_limit");
        const forbidden = allAccessIssues.filter((issue) => issue.reason === "forbidden");
        if (rateLimited.length > 0) {
          const list = rateLimited.map((s) => `${s.repo}#${s.issueNumber}`).join(", ");
          logger.warn(`Rate limited on ${rateLimited.length} issue(s): ${list}`);
          core.warning(`Rate limited on ${rateLimited.length} issue(s)`);
        }
        if (forbidden.length > 0) {
          const list = forbidden.map((s) => `${s.repo}#${s.issueNumber}`).join(", ");
          logger.warn(`Forbidden on ${forbidden.length} issue(s): ${list}`);
          core.warning(`Forbidden on ${forbidden.length} issue(s)`);
        }
      }
    },
  });
}

runIfMain(import.meta.url, main);
