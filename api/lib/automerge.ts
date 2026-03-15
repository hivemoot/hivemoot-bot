/**
 * Automerge PR Classification
 *
 * Evaluates whether a PR qualifies for automatic merging based on:
 * 1. PR state: not a draft and no merge conflicts
 * 2. File paths pass allowlist/denylist filtering
 * 3. File count within maxFiles threshold
 * 4. Total changed lines within maxChangedLines threshold
 * 5. Minimum approvals from trusted reviewers
 * 6. CI checks passing (when requireChecks is true)
 *
 * All conditions must pass before the `hivemoot:automerge` label is applied.
 * Phase 1 (dryRun: true) = label only, no merge action.
 *
 * Short-circuit order optimized by API cost:
 * config → draft/mergeable gates (zero cost from webhook payload) → files → approvals (1 call) → CI (2 calls)
 */

import { minimatch } from "minimatch";
import { LABELS, isLabelMatch } from "../config.js";
import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { AutomergeConfig } from "./repo-config.js";
import { isCIPassing } from "./merge-readiness.js";
import type { GraphQLClient } from "./graphql-queries.js";
import {
  enablePullRequestAutoMerge,
  disablePullRequestAutoMerge,
  getPRNodeId,
} from "./graphql-queries.js";

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
  /** Draft state from webhook payload. True → skip classification. */
  draft?: boolean;
  /** Mergeable state from webhook payload. False → skip; null = unknown (GitHub still computing). */
  mergeable?: boolean | null;
  /**
   * GraphQL client for Phase 2: enabling/disabling GitHub native auto-merge.
   * Required when config.dryRun is false. When omitted, auto-merge mutations
   * are skipped even if dryRun is false (label-only fallback).
   */
  graphqlClient?: GraphQLClient;
  /**
   * GraphQL node ID of the PR (pull_request.node_id from webhook payload).
   * Used to avoid an extra API call when calling auto-merge mutations.
   * Fetched automatically if graphqlClient is provided but prNodeId is not.
   */
  prNodeId?: string;
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
 * 2. PR state gates: draft → remove; merge conflicts → remove
 * 3. Fetch files → classify (file count, changed lines, path rules)
 * 4. Count trusted approvals → check ≥ minApprovals
 * 5. If requireChecks → check CI via isCIPassing()
 * 6. All pass → add label; any fail → remove label if present
 *
 * Phase 2 (dryRun: false): when graphqlClient is provided, also enables or
 * disables GitHub's native auto-merge via GraphQL mutations so GitHub handles
 * merge ordering and state freshness reliably.
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

  const { graphqlClient } = params;
  const useNativeMerge = !config.dryRun && graphqlClient !== undefined;

  // Resolve the PR node ID lazily — only needed for Phase 2 mutations.
  let resolvedNodeId: string | undefined = params.prNodeId;
  const resolveNodeId = async (): Promise<string | undefined> => {
    if (resolvedNodeId !== undefined) return resolvedNodeId;
    if (!graphqlClient) return undefined;
    resolvedNodeId = (await getPRNodeId(graphqlClient, ref.owner, ref.repo, ref.prNumber)) ?? undefined;
    return resolvedNodeId;
  };

  // Resolve current labels (use pre-fetched or fetch)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasAutomerge = labels.some(l => isLabelMatch(l, LABELS.AUTOMERGE));

  // Helper to remove label if present, and disable native auto-merge if Phase 2.
  const removeIfLabeled = async (reason: string): Promise<AutomergeResult> => {
    if (hasAutomerge) {
      await prs.removeLabel(ref, LABELS.AUTOMERGE);
      log?.info(`[PR #${ref.prNumber}] Removed automerge: ${reason}`);

      if (useNativeMerge) {
        const nodeId = await resolveNodeId();
        if (nodeId) {
          await disablePullRequestAutoMerge(graphqlClient!, nodeId);
          log?.info(`[PR #${ref.prNumber}] Disabled native auto-merge`);
        }
      }

      return { action: "unlabeled", reason };
    }
    return { action: "noop", labeled: false };
  };

  // 2. PR state gates — cheaper than file/approval/CI API calls
  if (params.draft === true) {
    return removeIfLabeled("PR is a draft");
  }
  if (params.mergeable === false) {
    return removeIfLabeled("PR has merge conflicts");
  }

  // 3. Fetch files and classify
  const files = await prs.listFiles(ref, { earlyExitThreshold: config.maxFiles });
  const classification = classifyFiles(files, config);

  if (!classification.eligible) {
    return removeIfLabeled(classification.reason);
  }

  // 4. Check trusted approvals
  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovalCount = trustedReviewers.filter(r => approvers.has(r)).length;

  if (trustedApprovalCount < config.minApprovals) {
    return removeIfLabeled(
      `insufficient approvals: ${trustedApprovalCount}/${config.minApprovals}`
    );
  }

  // 5. Check CI if required
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

  // 6. All conditions met → add label if not present
  if (!hasAutomerge) {
    await prs.addLabels(ref, [LABELS.AUTOMERGE]);
    log?.info(`[PR #${ref.prNumber}] Added automerge label`);

    if (useNativeMerge) {
      const nodeId = await resolveNodeId();
      if (nodeId) {
        const mergeMethod = config.mergeMethod.toUpperCase() as "SQUASH" | "MERGE" | "REBASE";
        await enablePullRequestAutoMerge(graphqlClient!, nodeId, mergeMethod);
        log?.info(`[PR #${ref.prNumber}] Enabled native auto-merge (${config.mergeMethod})`);
      }
    }

    return { action: "labeled" };
  }

  return { action: "noop", labeled: true };
}
