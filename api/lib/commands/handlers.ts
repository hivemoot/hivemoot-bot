/**
 * Command Handlers
 *
 * Implements the command execution logic for bot commands.
 * Each handler receives a validated, authorized command context
 * and performs the corresponding governance action.
 */

import { LABELS, SIGNATURE, isLabelMatch } from "../../config.js";
import { createIssueOperations, createGovernanceService, createPROperations, loadRepositoryConfig } from "../index.js";
import { evaluatePreflightChecks } from "../merge-readiness.js";
import type { PreflightCheckItem } from "../merge-readiness.js";
import { CommitMessageGenerator, formatCommitMessage } from "../llm/commit-message.js";
import type { PRContext } from "../llm/types.js";
import type { IssueRef, PRRef } from "../types.js";

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
 * Check if the bot has already reacted to this comment with a processing
 * marker (👀 for known commands, 😕 for unknown commands).
 * Used as an idempotency guard against webhook retries.
 */
async function alreadyProcessed(ctx: CommandContext): Promise<boolean> {
  try {
    // Check both marker reactions: eyes (known commands) and confused (unknown commands)
    const [eyesRes, confusedRes] = await Promise.all([
      ctx.octokit.rest.reactions.listForIssueComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: ctx.commentId,
        content: "eyes",
        per_page: 100,
      }),
      ctx.octokit.rest.reactions.listForIssueComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: ctx.commentId,
        content: "confused",
        per_page: 100,
      }),
    ]);
    // Check if any marker reaction was created by our app's bot account.
    // GitHub App bot usernames follow the pattern "<app-slug>[bot]".
    const hasBotReaction = (reactions: typeof eyesRes.data) =>
      reactions.some((r) => r.user?.login.endsWith("[bot]"));
    return hasBotReaction(eyesRes.data) || hasBotReaction(confusedRes.data);
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
 * Handle /squash command: run preflight and squash-merge when all hard checks pass.
 *
 * Behavior:
 * - PR-only command
 * - Fail-closed: blocks merge when checks fail or commit message generation fails
 * - Requires repository squash-merge capability to be enabled
 * - Re-runs preflight immediately before merge to reduce stale CI race windows
 */
async function handleSquash(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/squash` command can only be used on pull requests, not issues." };
  }

  const octokit = ctx.octokit as any; // Full Probot client at runtime
  const prs = createPROperations(octokit, { appId: ctx.appId });
  const repoConfig = await loadRepositoryConfig(octokit, ctx.owner, ctx.repo);
  const ref: PRRef = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.issueNumber };
  const currentLabels = ctx.issueLabels.map((l) => l.name);

  const pr = await prs.get(ref);
  if (pr.merged || pr.state !== "open") {
    return { status: "rejected", reason: "This pull request is already closed or merged." };
  }
  const expectedHeadSha = pr.headSha;

  const repoInfo = await octokit.rest.repos.get({ owner: ctx.owner, repo: ctx.repo });
  if (!repoInfo?.data?.allow_squash_merge) {
    return { status: "rejected", reason: "Squash merge is disabled for this repository. Enable it in repository settings before using `/squash`." };
  }

  const preflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr.mergeReady,
    trustedReviewers: repoConfig.governance.pr.trustedReviewers,
    currentLabels,
  });

  const checklistLines = preflight.checks.map(formatCheckItem);
  const hardCount = preflight.checks.filter((c) => c.severity === "hard").length;
  const hardPassed = preflight.checks.filter((c) => c.severity === "hard" && c.passed).length;

  let body = `## 🐝 Squash Preflight for #${ctx.issueNumber}\n\n`;
  body += `### Checklist\n\n`;
  body += checklistLines.join("\n") + "\n\n";

  if (!preflight.allHardChecksPassed) {
    body += `**${hardPassed}/${hardCount} hard checks passed.** Squash merge was blocked.`;
    return { status: "rejected", reason: body };
  }

  let commitTitle = "";
  let commitBody = "";
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

    if (!result.success) {
      body += "### Commit Message\n\n";
      body += "Commit message generation failed. Squash merge was blocked.\n\n";
      body += `**${hardPassed}/${hardCount} hard checks passed.** Retry \`/squash\` after the generator is healthy.`;
      return { status: "rejected", reason: body };
    }

    commitTitle = result.message.subject.trim();
    const generatedBody = result.message.body.trim();
    commitBody = generatedBody
      ? `${generatedBody}\n\nPR: #${ctx.issueNumber}`
      : `PR: #${ctx.issueNumber}`;
    body += "### Proposed Commit Message\n\n";
    body += "```\n" + formatCommitMessage(result.message, ctx.issueNumber) + "\n```\n\n";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: error }, `Commit message generation failed during /squash: ${reason}`);
    body += "### Commit Message\n\n";
    body += "Commit message generation failed. Squash merge was blocked.\n\n";
    body += `**${hardPassed}/${hardCount} hard checks passed.** Retry \`/squash\` after the generator is healthy.`;
    return { status: "rejected", reason: body };
  }

  const freshPreflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr.mergeReady,
    trustedReviewers: repoConfig.governance.pr.trustedReviewers,
    currentLabels,
  });
  if (!freshPreflight.allHardChecksPassed) {
    const freshHardCount = freshPreflight.checks.filter((c) => c.severity === "hard").length;
    const freshHardPassed = freshPreflight.checks.filter((c) => c.severity === "hard" && c.passed).length;
    body += `**${freshHardPassed}/${freshHardCount} hard checks passed on final verification.** Checks changed while processing; squash merge was blocked.`;
    return { status: "rejected", reason: body };
  }

  try {
    await octokit.rest.pulls.merge({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.issueNumber,
      sha: expectedHeadSha,
      merge_method: "squash",
      commit_title: commitTitle,
      commit_message: commitBody,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: error }, `Squash merge failed for #${ctx.issueNumber}: ${reason}`);
    body += "### Merge\n\n";
    body += "Squash merge failed due to a GitHub merge API error. Resolve merge blockers and retry.\n\n";
    return { status: "rejected", reason: body };
  }

  body += `**${hardPassed}/${hardCount} hard checks passed.** Squash merge completed successfully.`;
  await reply(ctx, body);
  return { status: "executed", message: "Squash merge completed." };
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

// ─────────────────────────────────────────────────────────────────────────────
// Command Router
// ─────────────────────────────────────────────────────────────────────────────

/** Registry mapping command verbs to their handlers */
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  vote: handleVote,
  implement: handleImplement,
  preflight: handlePreflight,
  squash: handleSquash,
};

/** Exported list of recognized command verbs for help messages and validation. */
export const KNOWN_COMMANDS = Object.keys(COMMAND_HANDLERS);

/**
 * Execute a parsed command.
 *
 * Authorization flow:
 * 1. Check sender permissions → silent ignore if not authorized
 * 2. Check idempotency (eyes/confused reaction) → skip on retry
 * 3. Unknown command → react confused + reply with available commands
 * 4. React with 👀 to acknowledge receipt
 * 5. Execute the handler
 * 6. React with ✅ on success, post error comment on rejection
 */
export async function executeCommand(ctx: CommandContext): Promise<CommandResult> {
  const handler = COMMAND_HANDLERS[ctx.verb];

  // Authorization: only maintainers can use commands
  const authorized = await isAuthorized(ctx);
  if (!authorized) {
    // Per issue #81: "for everyone else this should be ignored"
    ctx.log.info(
      `Command /${ctx.verb} from unauthorized user ${ctx.senderLogin} on #${ctx.issueNumber} — ignoring`,
    );
    return { status: "ignored" };
  }

  // Idempotency guard: if we already reacted with 👀 or 😕, this is a webhook
  // retry and the command was already executed. Skip to prevent duplicates.
  if (await alreadyProcessed(ctx)) {
    ctx.log.info(
      `Command /${ctx.verb} on comment ${ctx.commentId} already processed — skipping retry`,
    );
    return { status: "ignored" };
  }

  if (!handler) {
    // Unknown command from an authorized user — reply with available commands
    const available = KNOWN_COMMANDS.map((c) => `\`/${c}\``).join(", ");
    await react(ctx, "confused");
    await reply(ctx, `Unknown command \`/${ctx.verb}\`. Available commands: ${available}`);
    return { status: "rejected", reason: `Unknown command: /${ctx.verb}` };
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
