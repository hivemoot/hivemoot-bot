/**
 * Command Handlers
 *
 * Implements the command execution logic for bot commands.
 * Each handler receives a validated, authorized command context
 * and performs the corresponding governance action.
 */

import { LABELS, SIGNATURE, isLabelMatch } from "../../config.js";
import { hasSameRepoClosingKeywordRef } from "../closing-keywords.js";
import { CommitMessageGenerator } from "../llm/index.js";
import {
  createIssueOperations,
  createGovernanceService,
  createPROperations,
  evaluateMergeReadinessSignals,
  loadRepositoryConfig,
} from "../index.js";
import type { IssueRef } from "../types.js";

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
  issueTitle: string;
  issueBody: string;
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

function checklistLine(checked: boolean, label: string, details: string): string {
  return `- [${checked ? "x" : " "}] **${label}**: ${details}`;
}

/**
 * Handle /preflight command: evaluate merge-readiness checklist for a PR.
 */
async function handlePreflight(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/preflight` command can only be used on pull requests." };
  }

  const prs = createPROperations(ctx.octokit, { appId: ctx.appId });
  const repoConfig = await loadRepositoryConfig(
    ctx.octokit as unknown as Parameters<typeof loadRepositoryConfig>[0],
    ctx.owner,
    ctx.repo,
  );
  const prRef = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.issueNumber };
  const pr = await prs.get(prRef);

  const trustedReviewers = repoConfig.governance.pr.trustedReviewers;
  const requiredApprovals = Math.max(
    1,
    repoConfig.governance.pr.mergeReady?.minApprovals ?? 1,
  );

  const readiness = await evaluateMergeReadinessSignals({
    prs,
    ref: prRef,
    trustedReviewers,
    minApprovals: requiredApprovals,
    shortCircuitCI: false,
  });

  const isOpen = pr.state === "open";
  const notMerged = !pr.merged;
  const hasDescription = ctx.issueBody.trim().length > 0;
  const hasLinkedIssueKeyword = hasSameRepoClosingKeywordRef(ctx.issueBody, {
    owner: ctx.owner,
    repo: ctx.repo,
  });
  const mergeReadyLabelPresent = hasLabel(ctx, LABELS.MERGE_READY);

  const hardChecks = {
    openAndUnmerged: isOpen && notMerged,
    approvals: readiness.hasSufficientApprovals,
    ci: readiness.ciPassing,
    conflicts: !readiness.hasMergeConflicts,
  };
  const allHardChecksPass = Object.values(hardChecks).every(Boolean);

  const lines: string[] = [];
  lines.push("# 🐝 Preflight Report");
  lines.push("");
  lines.push("## Hard Checks");
  lines.push(
    checklistLine(
      hardChecks.openAndUnmerged,
      "PR is open and unmerged",
      hardChecks.openAndUnmerged ? "PR is open and not merged." : `state=${pr.state}, merged=${String(pr.merged)}.`,
    ),
  );
  lines.push(
    checklistLine(
      hardChecks.approvals,
      "Trusted approvals",
      `${readiness.trustedApprovalCount}/${readiness.requiredApprovals} trusted approvals (${trustedReviewers.join(", ") || "none configured"}).`,
    ),
  );
  lines.push(
    checklistLine(
      hardChecks.ci,
      "CI status",
      hardChecks.ci ? "All checks and commit statuses are passing." : "At least one check/status is failing or pending.",
    ),
  );
  lines.push(
    checklistLine(
      hardChecks.conflicts,
      "Merge conflicts",
      hardChecks.conflicts ? "No merge conflicts detected." : "GitHub reports merge conflicts.",
    ),
  );
  lines.push("");
  lines.push("## Advisory Checks");
  lines.push(
    checklistLine(
      mergeReadyLabelPresent,
      "Merge-ready label",
      mergeReadyLabelPresent ? "Present." : "Not present (advisory only).",
    ),
  );
  lines.push(
    checklistLine(
      hasLinkedIssueKeyword,
      "Linked issue keyword",
      hasLinkedIssueKeyword
        ? "Closing keyword detected in PR description."
        : "No closing keyword found (e.g., `Fixes #123`).",
    ),
  );
  lines.push(
    checklistLine(
      hasDescription,
      "PR description",
      hasDescription ? "Description is present." : "Description is empty.",
    ),
  );
  lines.push("");

  if (allHardChecksPass) {
    const generator = new CommitMessageGenerator();
    const commitMessage = await generator.generate({
      prNumber: ctx.issueNumber,
      prTitle: ctx.issueTitle,
      prBody: ctx.issueBody,
      linkedIssuesHint: hasLinkedIssueKeyword ? "closing keyword present" : "no closing keyword found",
      commitHeadlines: [],
    });

    lines.push("## Proposed Commit Message");
    if (commitMessage.success) {
      lines.push("```");
      lines.push(commitMessage.suggestion.subject);
      lines.push("");
      lines.push(commitMessage.suggestion.body);
      lines.push("");
      lines.push(`PR: #${ctx.issueNumber}`);
      lines.push("```");
    } else {
      lines.push(`LLM commit message generation unavailable: ${commitMessage.reason}.`);
    }
  } else {
    lines.push("## Proposed Commit Message");
    lines.push("Skipped because one or more hard checks failed.");
  }

  await reply(ctx, lines.join("\n"));
  return { status: "executed", message: "Posted preflight checklist." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Router
// ─────────────────────────────────────────────────────────────────────────────

/** Registry mapping command verbs to their handlers */
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  vote: handleVote,
  implement: handleImplement,
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
