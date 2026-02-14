/**
 * Merge-Readiness Evaluation
 *
 * Determines whether a PR meets all technical prerequisites for merging
 * and manages the `merge-ready` label accordingly.
 *
 * Conditions for the label (all must be true):
 * 1. PR has `implementation` label (active competing PR)
 * 2. At least minApprovals approvals from trustedReviewers
 * 3. PR is not conflicting (`mergeable !== false`; `null` = not yet computed, allowed)
 * 4. All check runs on HEAD are completed with success/neutral/skipped
 * 5. All commit statuses on HEAD are success (legacy Status API)
 *
 * Short-circuit order optimized by API cost:
 * config → labels → approvals (1 call) → PR fetch (headSha + mergeable) → mergeable → CI (2 calls)
 */

import { LABELS, isLabelMatch } from "../config.js";
import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { MergeReadyConfig } from "./repo-config.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface MergeReadinessParams {
  prs: PROperations;
  ref: PRRef;
  config: MergeReadyConfig | null;
  trustedReviewers: string[];
  /** Pre-fetched labels to avoid extra API call (from webhook payload). */
  currentLabels?: string[];
  /** HEAD SHA to check CI against. Fetched from PR if not provided. */
  headSha?: string;
  log?: { info: (msg: string) => void; debug?: (msg: string) => void };
}

export interface MergeReadinessSignalsParams {
  prs: PROperations;
  ref: PRRef;
  trustedReviewers: string[];
  minApprovals: number;
  /** HEAD SHA to check CI against. Fetched from PR if not provided. */
  headSha?: string;
}

export interface MergeReadinessSignals {
  trustedApprovalCount: number;
  requiredApprovals: number;
  hasSufficientApprovals: boolean;
  hasMergeConflicts: boolean;
  ciPassing: boolean;
}

export type MergeReadinessResult =
  | { action: "skipped"; reason: string }
  | { action: "added" }
  | { action: "removed" }
  | { action: "noop"; labeled: boolean };

// ───────────────────────────────────────────────────────────────────────────────
// Evaluation
// ───────────────────────────────────────────────────────────────────────────────

/** Check run conclusions that count as passing. */
const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Evaluate whether a PR meets all merge-readiness conditions and
 * add or remove the `merge-ready` label accordingly.
 *
 * Idempotent: safe to call multiple times for the same PR.
 */
export async function evaluateMergeReadiness(
  params: MergeReadinessParams
): Promise<MergeReadinessResult> {
  const { prs, ref, config, trustedReviewers, log } = params;

  // 1. Feature disabled → skip
  if (!config) {
    return { action: "skipped", reason: "feature disabled" };
  }

  // 2. Check implementation label (use pre-fetched labels or fetch)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasImplementation = labels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION));
  const hasMergeReady = labels.some(l => isLabelMatch(l, LABELS.MERGE_READY));

  if (!hasImplementation) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: no implementation label`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "no implementation label" };
  }

  const signals = await evaluateMergeReadinessSignals({
    prs,
    ref,
    trustedReviewers,
    minApprovals: config.minApprovals,
    headSha: params.headSha,
  });

  // 3. Check trusted approvals (1 API call)
  if (!signals.hasSufficientApprovals) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(
        `[PR #${ref.prNumber}] Removed merge-ready: ${signals.trustedApprovalCount}/${config.minApprovals} trusted approvals`
      );
      return { action: "removed" };
    }
    return {
      action: "skipped",
      reason: `insufficient approvals (${signals.trustedApprovalCount}/${config.minApprovals})`,
    };
  }

  // 4. Check mergeable state (null = not yet computed by GitHub, allow through)
  if (signals.hasMergeConflicts) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: has merge conflicts`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "has merge conflicts" };
  }

  // 5. Check CI status (2 API calls in parallel)
  if (!signals.ciPassing) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: CI not passing`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "CI not passing" };
  }

  // All conditions met → add label if not present
  if (!hasMergeReady) {
    await prs.addLabels(ref, [LABELS.MERGE_READY]);
    log?.info(`[PR #${ref.prNumber}] Added merge-ready label`);
    return { action: "added" };
  }

  return { action: "noop", labeled: true };
}

/**
 * Evaluate merge-readiness technical signals without mutating labels.
 *
 * Shared by merge-ready label automation and `/preflight` command reporting.
 */
export async function evaluateMergeReadinessSignals(
  params: MergeReadinessSignalsParams
): Promise<MergeReadinessSignals> {
  const { prs, ref, trustedReviewers, minApprovals } = params;

  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovalCount = trustedReviewers.filter((reviewer) =>
    approvers.has(reviewer)
  ).length;

  let headSha: string;
  let mergeable: boolean | null;
  if (params.headSha) {
    headSha = params.headSha;
    // When headSha is pre-fetched (webhook payload), mergeability may be absent.
    mergeable = null;
  } else {
    const pr = await prs.get(ref);
    headSha = pr.headSha;
    mergeable = pr.mergeable;
  }

  // Preserve original short-circuit behavior: conflicts fail before CI calls.
  const ciPassing = mergeable === false ? false : await isCIPassing(prs, ref, headSha);

  return {
    trustedApprovalCount,
    requiredApprovals: minApprovals,
    hasSufficientApprovals: trustedApprovalCount >= minApprovals,
    hasMergeConflicts: mergeable === false,
    ciPassing,
  };
}

/**
 * Check that all CI signals are passing for the given SHA.
 *
 * Queries both the Checks API (GitHub Actions) and the legacy Status API
 * (external CI like Jenkins) in parallel. Both must pass.
 *
 * Zero checks/statuses = treated as passing (repo has no CI configured).
 */
async function isCIPassing(
  prs: PROperations,
  ref: PRRef,
  sha: string
): Promise<boolean> {
  const [checksResult, statusResult] = await Promise.all([
    prs.getCheckRunsForRef(ref.owner, ref.repo, sha),
    prs.getCombinedStatus(ref.owner, ref.repo, sha),
  ]);

  // Fail-closed if check runs were truncated (>100) — we can't verify unseen checks
  if (checksResult.totalCount > checksResult.checkRuns.length) {
    return false;
  }

  // Check Runs: all must be completed with a passing conclusion
  for (const checkRun of checksResult.checkRuns) {
    if (checkRun.status !== "completed") {
      return false;
    }
    if (!checkRun.conclusion || !PASSING_CHECK_CONCLUSIONS.has(checkRun.conclusion)) {
      return false;
    }
  }

  // Legacy Status API: combined state must be "success" or no statuses at all
  if (statusResult.totalCount > 0 && statusResult.state !== "success") {
    return false;
  }

  return true;
}
