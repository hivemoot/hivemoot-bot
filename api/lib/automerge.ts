/**
 * Automerge PR Classification
 *
 * Evaluates whether a PR qualifies for automatic merging based on:
 * 1. File paths pass allowlist/denylist filtering
 * 2. File count within maxFiles threshold
 * 3. Total changed lines within maxChangedLines threshold
 * 4. Minimum approvals from trusted reviewers
 * 5. CI checks passing (when requireChecks is true)
 *
 * All conditions must pass before the `hivemoot:automerge` label is applied.
 * Phase 1 (dryRun: true) = label only, no merge action.
 *
 * Short-circuit order optimized by API cost:
 * config → files (cheapest, already fetched) → approvals (1 call) → CI (2 calls)
 */

import { minimatch } from "minimatch";
import { LABELS, isLabelMatch } from "../config.js";
import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { AutomergeConfig } from "./repo-config.js";
import { isCIPassing } from "./merge-readiness.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  eligible: boolean;
  reason: string;
}

export type AutomergeResult =
  | { action: "skipped"; reason: string }
  | { action: "labeled" }
  | { action: "unlabeled"; reason: string }
  | { action: "noop"; labeled: boolean };

export interface AutomergeParams {
  prs: PROperations;
  ref: PRRef;
  config: AutomergeConfig | null;
  trustedReviewers: string[];
  /** HEAD SHA for CI check. Fetched from PR if not provided. */
  headSha?: string;
  /** Pre-fetched labels from webhook payload to avoid extra API call. */
  currentLabels?: string[];
  log?: { info: (msg: string) => void };
}

/** Shape of a file entry from PROperations.listFiles */
interface PRFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  status: string;
  /** Source path for renamed files. Must also pass path checks. */
  previous_filename?: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// Pure Classification Functions (no side effects)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a single file is allowed by the automerge path rules.
 * Deny patterns are checked first — a denied file is never allowed.
 * Then the file must match at least one allowedPaths pattern.
 */
export function isFileAllowed(
  filename: string,
  allowedPaths: string[],
  denyPaths: string[]
): boolean {
  // Deny-first: if any deny pattern matches, file is rejected
  for (const pattern of denyPaths) {
    if (minimatch(filename, pattern, { dot: true })) {
      return false;
    }
  }

  // Must match at least one allow pattern
  for (const pattern of allowedPaths) {
    if (minimatch(filename, pattern, { dot: true })) {
      return true;
    }
  }

  return false;
}

/**
 * Classify whether a set of PR files qualifies for automerge.
 * Checks file count, total changed lines, and path rules.
 *
 * Returns { eligible: true } when all file-level conditions pass,
 * or { eligible: false, reason } explaining the first failure.
 */
export function classifyFiles(
  files: PRFile[],
  config: AutomergeConfig
): ClassifyResult {
  // Empty PRs don't qualify — nothing to merge
  if (files.length === 0) {
    return { eligible: false, reason: "no files changed" };
  }

  // File count check
  if (files.length > config.maxFiles) {
    return {
      eligible: false,
      reason: `too many files: ${files.length} > ${config.maxFiles}`,
    };
  }

  // Total changed lines check
  let totalChangedLines = 0;
  for (const file of files) {
    totalChangedLines += file.additions + file.deletions;
  }
  if (totalChangedLines > config.maxChangedLines) {
    return {
      eligible: false,
      reason: `too many changed lines: ${totalChangedLines} > ${config.maxChangedLines}`,
    };
  }

  // Path rules check — every file must be allowed.
  // For renames, both source and destination paths must pass.
  for (const file of files) {
    if (!isFileAllowed(file.filename, config.allowedPaths, config.denyPaths)) {
      return {
        eligible: false,
        reason: `file not allowed: ${file.filename}`,
      };
    }

    if (file.previous_filename && !isFileAllowed(file.previous_filename, config.allowedPaths, config.denyPaths)) {
      return {
        eligible: false,
        reason: `file not allowed: ${file.previous_filename} (renamed to ${file.filename})`,
      };
    }
  }

  return { eligible: true, reason: "all file checks passed" };
}

// ───────────────────────────────────────────────────────────────────────────────
// Label Evaluator (side effects, follows merge-readiness pattern)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a PR qualifies for automerge and add/remove the label.
 *
 * Orchestrates all checks in short-circuit order:
 * 1. Config null → skip
 * 2. Fetch files → classify (file count, changed lines, path rules)
 * 3. Count trusted approvals → check ≥ minApprovals
 * 4. If requireChecks → check CI via isCIPassing()
 * 5. All pass → add label; any fail → remove label if present
 *
 * Idempotent: safe to call multiple times for the same PR.
 */
export async function evaluateAutomerge(
  params: AutomergeParams
): Promise<AutomergeResult> {
  const { prs, ref, config, trustedReviewers, log } = params;

  // 1. Feature disabled → skip
  if (!config) {
    return { action: "skipped", reason: "feature disabled" };
  }

  // Resolve current labels (use pre-fetched or fetch)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasAutomerge = labels.some(l => isLabelMatch(l, LABELS.AUTOMERGE));

  // Helper to remove label if present
  const removeIfLabeled = async (reason: string): Promise<AutomergeResult> => {
    if (hasAutomerge) {
      await prs.removeLabel(ref, LABELS.AUTOMERGE);
      log?.info(`[PR #${ref.prNumber}] Removed automerge: ${reason}`);
      return { action: "unlabeled", reason };
    }
    return { action: "noop", labeled: false };
  };

  // 2. Fetch files and classify
  const files = await prs.listFiles(ref, { earlyExitThreshold: config.maxFiles });
  const classification = classifyFiles(files, config);

  if (!classification.eligible) {
    return removeIfLabeled(classification.reason);
  }

  // 3. Check trusted approvals
  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovalCount = trustedReviewers.filter(r => approvers.has(r)).length;

  if (trustedApprovalCount < config.minApprovals) {
    return removeIfLabeled(
      `insufficient approvals: ${trustedApprovalCount}/${config.minApprovals}`
    );
  }

  // 4. Check CI if required
  if (config.requireChecks) {
    let headSha = params.headSha;
    if (!headSha) {
      const pr = await prs.get(ref);
      headSha = pr.headSha;
    }

    const ciPassing = await isCIPassing(prs, ref, headSha);
    if (!ciPassing) {
      return removeIfLabeled("CI not passing");
    }
  }

  // All conditions met → add label if not present
  if (!hasAutomerge) {
    await prs.addLabels(ref, [LABELS.AUTOMERGE]);
    log?.info(`[PR #${ref.prNumber}] Added automerge label`);
    return { action: "labeled" };
  }

  return { action: "noop", labeled: true };
}
