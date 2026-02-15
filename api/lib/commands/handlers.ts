/**
 * Command Handlers
 *
 * Implements the command execution logic for bot commands.
 * Each handler receives a validated, authorized command context
 * and performs the corresponding governance action.
 */

import * as yaml from "js-yaml";
import { LABELS, REQUIRED_REPOSITORY_LABELS, SIGNATURE, isLabelMatch } from "../../config.js";
import {
  createIssueOperations,
  createGovernanceService,
  createPROperations,
  createRepositoryLabelService,
  loadRepositoryConfig,
} from "../index.js";
import { getRepoDiscussionInfo } from "../discussions.js";
import { getLLMReadiness } from "../llm/provider.js";
import { evaluatePreflightChecks } from "../merge-readiness.js";
import type { PreflightCheckItem } from "../merge-readiness.js";
import { CommitMessageGenerator, formatCommitMessage } from "../llm/commit-message.js";
import type { PRContext } from "../llm/types.js";
import type { IssueRef, PRRef } from "../types.js";
import type { EffectiveConfig } from "../repo-config.js";

/**
 * Minimal interface for the octokit client needed by command handlers.
 * Uses the Probot context's octokit which has full REST API access.
 */
export interface CommandOctokit {
  rest: {
    repos: {
      getCollaboratorPermissionLevel: (params: {
        owner: string;
        repo: string;
        username: string;
      }) => Promise<{ data: { permission: string } }>;
    };
    reactions: {
      createForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
      }) => Promise<unknown>;
      listForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
        per_page?: number;
      }) => Promise<{ data: Array<{ user: { login: string } | null }> }>;
    };
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
}

/**
 * Context passed to command execution.
 */
export interface CommandContext {
  octokit: CommandOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  senderLogin: string;
  verb: string;
  freeText: string | undefined;
  /** Labels currently on the issue */
  issueLabels: Array<{ name: string }>;
  /** Whether this comment is on a PR (vs an issue) */
  isPullRequest: boolean;
  /** App ID for filtering bot comments */
  appId: number;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Result of a command execution attempt.
 */
export type CommandResult =
  | { status: "executed"; message: string }
  | { status: "ignored" }      // unauthorized or unrecognized
  | { status: "rejected"; reason: string };  // valid command but invalid state

/**
 * Permission levels that are allowed to execute commands.
 * Per issue #81: "only repo maintainers should use these commands"
 */
const AUTHORIZED_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Check if the sender has sufficient repo permissions to run commands.
 * Returns true if authorized, false otherwise.
 */
async function isAuthorized(ctx: CommandContext): Promise<boolean> {
  try {
    const { data } = await ctx.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: ctx.owner,
      repo: ctx.repo,
      username: ctx.senderLogin,
    });
    return AUTHORIZED_PERMISSIONS.has(data.permission);
  } catch (error) {
    // If we can't check permissions (e.g., user is not a collaborator), deny.
    // Log so persistent failures (expired token, rate limit) are visible.
    ctx.log.error(
      { err: error, user: ctx.senderLogin, issue: ctx.issueNumber },
      `Permission check failed for ${ctx.senderLogin} — denying command`,
    );
    return false;
  }
}

/**
 * Add a reaction to the command comment for acknowledgment.
 */
async function react(
  ctx: CommandContext,
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes",
): Promise<void> {
  try {
    await ctx.octokit.rest.reactions.createForIssueComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: ctx.commentId,
      content,
    });
  } catch (error) {
    // Reaction failure is non-critical — don't block command execution
    ctx.log.error(
      { err: error, commentId: ctx.commentId, content },
      `Failed to add ${content} reaction — continuing`,
    );
  }
}

/**
 * Post a reply comment on the issue. SIGNATURE is always appended —
 * callers should not include it in the body.
 * Failures are logged but do not propagate — the governance action may
 * have already completed, so crashing the handler is worse than a missing comment.
 */
async function reply(ctx: CommandContext, body: string): Promise<void> {
  try {
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.issueNumber,
      body: `${body}${SIGNATURE}`,
    });
  } catch (error) {
    ctx.log.error(
      { err: error, issue: ctx.issueNumber },
      `Failed to post reply comment on #${ctx.issueNumber} — continuing`,
    );
  }
}

/**
 * Check if the bot has already reacted with 👀 to this comment.
 * Used as an idempotency guard against webhook retries — if we already
 * processed a command (indicated by our eyes reaction), skip re-execution.
 */
async function alreadyProcessed(ctx: CommandContext): Promise<boolean> {
  try {
    const { data: reactions } = await ctx.octokit.rest.reactions.listForIssueComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: ctx.commentId,
      content: "eyes",
      per_page: 100,
    });
    // Check if any eyes reaction was created by our app's bot account.
    // GitHub App bot usernames follow the pattern "<app-slug>[bot]".
    return reactions.some((r) => r.user?.login.endsWith("[bot]"));
  } catch {
    // If we can't check reactions, proceed with execution to avoid
    // silently dropping commands due to transient API failures.
    return false;
  }
}

/**
 * Check if the issue currently has a specific label.
 */
function hasLabel(ctx: CommandContext, label: string): boolean {
  return ctx.issueLabels.some((l) => isLabelMatch(l.name, label));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle /vote command: transition issue from discussion → voting.
 */
async function handleVote(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/vote` command can only be used on issues, not pull requests." };
  }

  // Already in voting or later phase
  if (hasLabel(ctx, LABELS.VOTING)) {
    return { status: "rejected", reason: "This issue is already in the voting phase." };
  }
  if (hasLabel(ctx, LABELS.EXTENDED_VOTING)) {
    return { status: "rejected", reason: "This issue is already in extended voting." };
  }
  if (hasLabel(ctx, LABELS.READY_TO_IMPLEMENT)) {
    return { status: "rejected", reason: "This issue is already ready to implement." };
  }
  if (hasLabel(ctx, LABELS.REJECTED)) {
    return { status: "rejected", reason: "This issue has been rejected." };
  }

  // Must be in discussion phase
  if (!hasLabel(ctx, LABELS.DISCUSSION)) {
    return { status: "rejected", reason: "This issue is not in the discussion phase. The `/vote` command requires `hivemoot:discussion`." };
  }

  const ref: IssueRef = { owner: ctx.owner, repo: ctx.repo, issueNumber: ctx.issueNumber };
  const issues = createIssueOperations(ctx.octokit, { appId: ctx.appId });
  const governance = createGovernanceService(issues);

  await governance.transitionToVoting(ref);

  return { status: "executed", message: "Moved to voting phase." };
}

/**
 * Handle /implement command: transition issue to ready-to-implement.
 *
 * This is a fast-track command that moves an issue directly to
 * ready-to-implement, bypassing or concluding voting early.
 * Valid from: discussion, voting, extended-voting, or needs-human phases.
 */
async function handleImplement(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/implement` command can only be used on issues, not pull requests." };
  }

  if (hasLabel(ctx, LABELS.READY_TO_IMPLEMENT)) {
    return { status: "rejected", reason: "This issue is already ready to implement." };
  }
  if (hasLabel(ctx, LABELS.REJECTED)) {
    return { status: "rejected", reason: "This issue has been rejected." };
  }

  const ref: IssueRef = { owner: ctx.owner, repo: ctx.repo, issueNumber: ctx.issueNumber };
  const issues = createIssueOperations(ctx.octokit, { appId: ctx.appId });

  // Determine which phase label to remove
  let removeLabel: string | undefined;
  if (hasLabel(ctx, LABELS.DISCUSSION)) {
    removeLabel = LABELS.DISCUSSION;
  } else if (hasLabel(ctx, LABELS.VOTING)) {
    removeLabel = LABELS.VOTING;
  } else if (hasLabel(ctx, LABELS.EXTENDED_VOTING)) {
    removeLabel = LABELS.EXTENDED_VOTING;
  } else if (hasLabel(ctx, LABELS.NEEDS_HUMAN)) {
    removeLabel = LABELS.NEEDS_HUMAN;
  }

  if (!removeLabel) {
    return { status: "rejected", reason: "This issue is not in a phase that can transition to ready-to-implement." };
  }

  const message = `# 🐝 Fast-tracked to Implementation ⚡\n\nMoved to ready-to-implement by @${ctx.senderLogin} via \`/implement\` command.\n\nNext steps:\n- Open a PR for review if you plan to implement.\n- Link this issue in the PR description (e.g., \`Fixes #${ctx.issueNumber}\`).${SIGNATURE}`;

  await issues.transition(ref, {
    removeLabel,
    addLabel: LABELS.READY_TO_IMPLEMENT,
    comment: message,
    unlock: true,
  });

  return { status: "executed", message: "Fast-tracked to ready-to-implement." };
}

/**
 * Handle /preflight command: generate a merge readiness report for a PR.
 *
 * Runs the same hard checks used by the merge-ready label automation,
 * plus advisory checks, and optionally generates an LLM commit message.
 * Posts the full report as a PR comment.
 */
async function handlePreflight(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/preflight` command can only be used on pull requests, not issues." };
  }

  // The octokit passed to commands is the full Probot octokit (cast to the
  // minimal CommandOctokit interface). createPROperations and loadRepositoryConfig
  // validate the shape at runtime. These casts are safe because the actual
  // Probot client has all required methods — only the declared type is narrow.
  const octokit = ctx.octokit as any; // Full Probot client at runtime
  const prs = createPROperations(octokit, { appId: ctx.appId });
  const repoConfig = await loadRepositoryConfig(octokit, ctx.owner, ctx.repo);

  const ref: PRRef = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.issueNumber };
  const currentLabels = ctx.issueLabels.map(l => l.name);

  // Run shared preflight checks (same signals as merge-ready label)
  const preflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr.mergeReady,
    trustedReviewers: repoConfig.governance.pr.trustedReviewers,
    currentLabels,
  });

  // Build checklist markdown
  const checklistLines = preflight.checks.map(formatCheckItem);

  const hardCount = preflight.checks.filter(c => c.severity === "hard").length;
  const hardPassed = preflight.checks.filter(c => c.severity === "hard" && c.passed).length;

  let body = `## 🐝 Preflight Check for #${ctx.issueNumber}\n\n`;
  body += `### Checklist\n\n`;
  body += checklistLines.join("\n") + "\n\n";

  // Generate commit message if all hard checks pass and LLM is configured
  if (preflight.allHardChecksPassed) {
    const commitMessageWarning =
      "[warning] I couldn't generate a recommended commit message this time.";

    try {
      const prContext = await gatherPRContext(ctx, ref);
      const noop = () => {};
      const generator = new CommitMessageGenerator({
        logger: {
          info: (...a: unknown[]) => ctx.log.info(...a),
          error: (...a: unknown[]) => ctx.log.error(...a),
          warn: noop,
          debug: noop,
          group: noop,
          groupEnd: noop,
        },
      });
      const result = await generator.generate(prContext);

      if (result.success) {
        const formatted = formatCommitMessage(result.message, ctx.issueNumber);
        body += `### Proposed Commit Message\n\n`;
        body += "```\n" + formatted + "\n```\n\n";
      } else {
        switch (result.kind) {
          case "generation_failed":
            body += `### Commit Message\n\n`;
            body += `${commitMessageWarning}\n\n`;
            break;
          case "not_configured":
            ctx.log.info("Commit message generation skipped: LLM not configured");
            break;
          default: {
            const _exhaustive: never = result.kind;
            ctx.log.error(`Unhandled commit message failure kind: ${_exhaustive}`);
            body += `### Commit Message\n\n`;
            body += `${commitMessageWarning}\n\n`;
            break;
          }
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.log.error({ err: error }, `Commit message generation failed: ${reason}`);
      // Keep detailed error in logs; show generic warning in PR comments.
      body += `### Commit Message\n\n`;
      body += `${commitMessageWarning}\n\n`;
    }
  } else {
    body += `### Commit Message\n\n`;
    body += `Commit message not generated — resolve failing hard checks first.\n\n`;
  }

  // Summary line
  if (preflight.allHardChecksPassed) {
    body += `**${hardPassed}/${hardCount} hard checks passed.** This PR is ready for merge.`;
  } else {
    body += `**${hardPassed}/${hardCount} hard checks passed.** Review the failing checks above before merging.`;
  }

  await reply(ctx, body);

  return { status: "executed", message: "Preflight report posted." };
}

/**
 * Format a single preflight check item as a markdown line.
 */
function formatCheckItem(check: PreflightCheckItem): string {
  const icon = check.passed ? "[x]" : (check.severity === "advisory" ? "[!]" : "[ ]");
  const severityTag = check.severity === "advisory" ? " *(advisory)*" : "";
  return `- ${icon} **${check.name}**: ${check.detail}${severityTag}`;
}

/**
 * Gather PR context for commit message generation.
 * Collects title, body, and commit messages via the full Probot octokit.
 */
async function gatherPRContext(
  ctx: CommandContext,
  ref: PRRef,
): Promise<PRContext> {
  const prContext: PRContext = {
    prNumber: ref.prNumber,
    title: "",
    body: "",
    diffStat: "",
    commitMessages: [],
  };

  try {
    // The command context receives the full Probot octokit cast to CommandOctokit.
    // For PR context gathering we need pulls.get and pulls.listCommits which are
    // available on the underlying client. This cast is safe — read-only operations.
    const fullOctokit = ctx.octokit as unknown as {
      rest: {
        pulls: {
          get: (p: { owner: string; repo: string; pull_number: number }) =>
            Promise<{ data: { title: string; body: string | null } }>;
          listCommits: (p: { owner: string; repo: string; pull_number: number; per_page?: number }) =>
            Promise<{ data: Array<{ commit: { message: string } }> }>;
        };
      };
    };

    const pullData = await fullOctokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
    });
    prContext.title = pullData.data.title;
    prContext.body = pullData.data.body ?? "";

    // Get commit messages
    const commits = await fullOctokit.rest.pulls.listCommits({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
      per_page: 100,
    });
    prContext.commitMessages = commits.data.map(c => c.commit.message.split("\n")[0]);
  } catch (error) {
    // Non-fatal — we still have the checklist
    ctx.log.error({ err: error }, "Failed to gather full PR context for commit message");
  }

  return prContext;
}

/**
 * Doctor check item severity.
 */
type DoctorCheckStatus = "pass" | "advisory" | "fail";

interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  subItems?: string[];
}

type DoctorRepoOctokit = {
  rest: {
    repos: {
      getContent: (params: { owner: string; repo: string; path: string }) => Promise<{ data: unknown }>;
      get: (params: { owner: string; repo: string }) => Promise<unknown>;
    };
    pulls: {
      list: (params: { owner: string; repo: string; state?: "open" | "closed" | "all"; per_page?: number }) => Promise<unknown>;
    };
    issues: {
      listLabelsForRepo: (params: { owner: string; repo: string; per_page?: number }) => Promise<unknown>;
    };
  };
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
};

function formatDoctorCheckItem(check: DoctorCheckResult): string {
  const icon = check.status === "pass" ? "[x]" : (check.status === "advisory" ? "[!]" : "[ ]");
  return `- ${icon} **${check.name}**: ${check.detail}`;
}

function formatDoctorSubItem(item: string): string {
  return `  - ${item}`;
}

function summarizeDoctorChecks(checks: DoctorCheckResult[]): string {
  const passed = checks.filter((c) => c.status === "pass").length;
  const advisories = checks.filter((c) => c.status === "advisory").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return `**${passed}/${checks.length} checks passed, ${advisories} advisories, ${failed} failures.**`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return String(err);
}

async function runDoctorCheck(
  name: string,
  run: () => Promise<DoctorCheckResult>,
): Promise<DoctorCheckResult> {
  try {
    return await run();
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: `Check failed: ${errorMessage(err)}`,
    };
  }
}

async function runLabelDoctorCheck(ctx: CommandContext): Promise<DoctorCheckResult> {
  const labels = createRepositoryLabelService(ctx.octokit as unknown);
  const result = await labels.ensureRequiredLabels(ctx.owner, ctx.repo);
  const maybeUpdated = (result as { updated?: unknown }).updated;
  const updatedCount = typeof maybeUpdated === "number" ? maybeUpdated : 0;
  const totalExpected = REQUIRED_REPOSITORY_LABELS.length;
  const totalFound = result.created + result.renamed + result.skipped + updatedCount;
  const status: DoctorCheckStatus = totalFound >= totalExpected ? "pass" : "fail";
  const detail = `${totalFound}/${totalExpected} labels accounted for (created ${result.created}, renamed ${result.renamed}, updated ${updatedCount}, already present ${result.skipped})`;
  const subItems = result.renamedLabels.length > 0
    ? result.renamedLabels.map((entry) => `Renamed \`${entry.from}\` -> \`${entry.to}\``)
    : ["No legacy labels were renamed"];

  return {
    name: "Labels",
    status,
    detail,
    subItems,
  };
}

async function runConfigDoctorCheck(
  ctx: CommandContext,
  repoConfig: EffectiveConfig,
): Promise<DoctorCheckResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const configPath = ".github/hivemoot.yml";

  try {
    const response = await octokit.rest.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: configPath,
    });
    const data = response.data as { type?: string; content?: string } | unknown[];

    if (Array.isArray(data) || typeof data !== "object" || data === null || data.type !== "file" || !data.content) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` exists but is not a valid file payload; defaults are active`,
      };
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` is empty; defaults are active`,
      };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        name: "Config",
        status: "fail",
        detail: `\`${configPath}\` must be a YAML object`,
      };
    }

    const intakeMethods = repoConfig.governance.pr.intake.map((entry) => entry.method).join(", ");
    return {
      name: "Config",
      status: "pass",
      detail: `Loaded \`${configPath}\` (intake: ${intakeMethods || "none"})`,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` not found; defaults are active`,
      };
    }

    if (err instanceof yaml.YAMLException) {
      return {
        name: "Config",
        status: "fail",
        detail: `Invalid YAML in \`${configPath}\`: ${err.message}`,
      };
    }

    return {
      name: "Config",
      status: "fail",
      detail: `Unable to load \`${configPath}\`: ${errorMessage(err)}`,
    };
  }
}

function runPRWorkflowDoctorCheck(repoConfig: EffectiveConfig): DoctorCheckResult {
  const intake = repoConfig.governance.pr.intake;
  const trustedReviewers = repoConfig.governance.pr.trustedReviewers;
  const usesApprovalIntake = intake.some((method) => method.method === "approval");
  const hasMergeReady = repoConfig.governance.pr.mergeReady !== null;
  const requiresTrustedReviewers = usesApprovalIntake || hasMergeReady;

  if (requiresTrustedReviewers && trustedReviewers.length === 0) {
    return {
      name: "PR Workflow",
      status: "fail",
      detail: "Approval-based intake/merge-ready is configured but `trustedReviewers` is empty",
    };
  }

  if (intake.length === 0) {
    return {
      name: "PR Workflow",
      status: "fail",
      detail: "No PR intake methods are configured",
    };
  }

  if (trustedReviewers.length === 0) {
    return {
      name: "PR Workflow",
      status: "advisory",
      detail: "No trusted reviewers configured; approval-based workflows are disabled",
    };
  }

  return {
    name: "PR Workflow",
    status: "pass",
    detail: `Configured intake methods: ${intake.map((method) => method.method).join(", ")} (trusted reviewers: ${trustedReviewers.length})`,
  };
}

async function runStandupDoctorCheck(
  ctx: CommandContext,
  repoConfig: EffectiveConfig,
): Promise<DoctorCheckResult> {
  if (!repoConfig.standup.enabled) {
    return {
      name: "Standup",
      status: "pass",
      detail: "Disabled (no action required)",
    };
  }

  if (!repoConfig.standup.category.trim()) {
    return {
      name: "Standup",
      status: "fail",
      detail: "`standup.enabled` is true but `standup.category` is empty",
    };
  }

  const discussions = await getRepoDiscussionInfo(ctx.octokit as unknown as DoctorRepoOctokit, ctx.owner, ctx.repo);
  if (!discussions.hasDiscussions) {
    return {
      name: "Standup",
      status: "fail",
      detail: "GitHub Discussions are disabled for this repository",
    };
  }

  const category = discussions.categories.find((entry) => entry.name === repoConfig.standup.category);
  if (!category) {
    return {
      name: "Standup",
      status: "fail",
      detail: `Category \`${repoConfig.standup.category}\` was not found`,
    };
  }

  return {
    name: "Standup",
    status: "pass",
    detail: `Category \`${repoConfig.standup.category}\` is available`,
  };
}

async function runPermissionsDoctorCheck(ctx: CommandContext): Promise<DoctorCheckResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const failures: string[] = [];

  const probes: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: "issues",
      run: async () => {
        await octokit.rest.issues.listLabelsForRepo({ owner: ctx.owner, repo: ctx.repo, per_page: 1 });
      },
    },
    {
      label: "pull_requests",
      run: async () => {
        await octokit.rest.pulls.list({ owner: ctx.owner, repo: ctx.repo, state: "open", per_page: 1 });
      },
    },
    {
      label: "metadata",
      run: async () => {
        await octokit.rest.repos.get({ owner: ctx.owner, repo: ctx.repo });
      },
    },
  ];

  for (const probe of probes) {
    try {
      await probe.run();
    } catch (err) {
      failures.push(`${probe.label}: ${errorMessage(err)}`);
    }
  }

  if (failures.length > 0) {
    return {
      name: "Permissions",
      status: "fail",
      detail: `${failures.length}/${probes.length} capability probes failed`,
      subItems: failures,
    };
  }

  return {
    name: "Permissions",
    status: "pass",
    detail: "Issues, pull requests, and metadata capability probes succeeded",
  };
}

function runLLMDoctorCheck(): DoctorCheckResult {
  const readiness = getLLMReadiness();
  if (readiness.ready) {
    return {
      name: "LLM",
      status: "pass",
      detail: "Provider, model, and API key are configured",
    };
  }

  if (readiness.reason === "api_key_missing") {
    return {
      name: "LLM",
      status: "fail",
      detail: "Provider/model configured but API key is missing",
    };
  }

  return {
    name: "LLM",
    status: "advisory",
    detail: "LLM integration is not configured",
  };
}

/**
 * Handle /doctor command: run a setup health report for the current repository.
 */
async function handleDoctor(ctx: CommandContext): Promise<CommandResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const repoConfig = await loadRepositoryConfig(octokit, ctx.owner, ctx.repo);

  const checks: DoctorCheckResult[] = [];
  checks.push(await runDoctorCheck("Labels", async () => runLabelDoctorCheck(ctx)));
  checks.push(await runDoctorCheck("Config", async () => runConfigDoctorCheck(ctx, repoConfig)));
  checks.push(await runDoctorCheck("PR Workflow", async () => runPRWorkflowDoctorCheck(repoConfig)));
  checks.push(await runDoctorCheck("Standup", async () => runStandupDoctorCheck(ctx, repoConfig)));
  checks.push(await runDoctorCheck("Permissions", async () => runPermissionsDoctorCheck(ctx)));
  checks.push(await runDoctorCheck("LLM", async () => runLLMDoctorCheck()));

  const lines: string[] = [
    "## 🐝 Doctor Report",
    "",
  ];
  for (const check of checks) {
    lines.push(formatDoctorCheckItem(check));
    if (check.subItems) {
      for (const subItem of check.subItems) {
        lines.push(formatDoctorSubItem(subItem));
      }
    }
  }
  lines.push("");
  lines.push(summarizeDoctorChecks(checks));

  await reply(
    ctx,
    lines.join("\n"),
  );

  return { status: "executed", message: "Doctor report posted." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Router
// ─────────────────────────────────────────────────────────────────────────────

/** Registry mapping command verbs to their handlers */
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  vote: handleVote,
  implement: handleImplement,
  doctor: handleDoctor,
  preflight: handlePreflight,
};

/**
 * Execute a parsed command.
 *
 * Authorization flow:
 * 1. Check if the verb is recognized → ignore if not
 * 2. Check sender permissions → silent ignore if not authorized
 * 3. React with 👀 to acknowledge receipt
 * 4. Execute the handler
 * 5. React with ✅ on success, post error comment on rejection
 */
export async function executeCommand(ctx: CommandContext): Promise<CommandResult> {
  const handler = COMMAND_HANDLERS[ctx.verb];
  if (!handler) {
    // Unknown command — silent ignore (not a command we handle)
    return { status: "ignored" };
  }

  // Authorization: only maintainers can use commands
  const authorized = await isAuthorized(ctx);
  if (!authorized) {
    // Per issue #81: "for everyone else this should be ignored"
    ctx.log.info(
      `Command /${ctx.verb} from unauthorized user ${ctx.senderLogin} on #${ctx.issueNumber} — ignoring`,
    );
    return { status: "ignored" };
  }

  // Idempotency guard: if we already reacted with 👀, this is a webhook
  // retry and the command was already executed. Skip to prevent duplicates.
  if (await alreadyProcessed(ctx)) {
    ctx.log.info(
      `Command /${ctx.verb} on comment ${ctx.commentId} already processed (eyes reaction found) — skipping retry`,
    );
    return { status: "ignored" };
  }

  // Acknowledge receipt
  await react(ctx, "eyes");

  ctx.log.info(
    `Executing command /${ctx.verb} from ${ctx.senderLogin} on #${ctx.issueNumber}`,
  );

  try {
    const result = await handler(ctx);

    if (result.status === "executed") {
      await react(ctx, "+1");
    } else if (result.status === "rejected") {
      await react(ctx, "confused");
      await reply(ctx, result.reason);
    }

    return result;
  } catch (error) {
    await react(ctx, "confused");
    ctx.log.error(
      { err: error, verb: ctx.verb, issue: ctx.issueNumber },
      `Command /${ctx.verb} failed`,
    );
    throw error;
  }
}
