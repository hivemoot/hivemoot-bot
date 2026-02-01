/**
 * Queen Bot Configuration
 *
 * Shared configuration for governance automation across webhook handlers
 * and scheduled scripts.
 */

import { SIGNATURES, buildNotificationComment, NOTIFICATION_TYPES } from "./lib/bot-comments.js";

// ───────────────────────────────────────────────────────────────────────────────
// Configuration Boundaries
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration boundaries for all tunable settings.
 * Used by both env-var parsing (global defaults) and repo-config parsing (per-repo overrides).
 * All duration values are in minutes.
 */
export const CONFIG_BOUNDS = {
  phaseDurationMinutes: {
    min: 1,
    max: 30 * 24 * 60, // 30 days
    default: 24 * 60, // 24 hours
  },
  prStaleDays: {
    min: 1,
    max: 30,
    default: 3,
  },
  maxPRsPerIssue: {
    min: 1,
    max: 10,
    default: 3,
  },
  // LLM configuration bounds
  llmMaxTokens: {
    min: 500,
    max: 8000,
    default: 2000,
  },
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// Phase Durations
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.default;
const MIN_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.min;
const MAX_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.max;

/**
 * Parse duration from environment variable with validation bounds.
 * Returns milliseconds.
 */
const parseMinutesToMs = (envVar: string | undefined, defaultMinutes: number): number => {
  const minutes = parseInt(envVar ?? "", 10);
  if (Number.isNaN(minutes)) {
    return defaultMinutes * 60 * 1000;
  }

  // Clamp to valid range
  const clampedMinutes = Math.max(
    MIN_PHASE_DURATION_MINUTES,
    Math.min(MAX_PHASE_DURATION_MINUTES, minutes)
  );

  return clampedMinutes * 60 * 1000;
};

export const DISCUSSION_DURATION_MS = parseMinutesToMs(
  process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES,
  DEFAULT_PHASE_DURATION_MINUTES
);

export const VOTING_DURATION_MS = parseMinutesToMs(
  process.env.HIVEMOOT_VOTING_DURATION_MINUTES,
  DEFAULT_PHASE_DURATION_MINUTES
);

// ───────────────────────────────────────────────────────────────────────────────
// Bot Signature & Identifiers
// ───────────────────────────────────────────────────────────────────────────────

export const SIGNATURE = "\n\n---\nbuzz buzz 🐝 Hivemoot Queen";

// ───────────────────────────────────────────────────────────────────────────────
// Message Templates
// ───────────────────────────────────────────────────────────────────────────────

/** Format vote results for display */
const formatVotes = (votes: { thumbsUp: number; thumbsDown: number; confused: number }) =>
  `**Results:** 👍 ${votes.thumbsUp} | 👎 ${votes.thumbsDown} | 😕 ${votes.confused}`;

export const MESSAGES = {
  // Posted when a new issue is opened
  ISSUE_WELCOME: `# 🐝 Discussion Phase

Welcome to hivemoot! Share your analysis, proposals, or concerns.

React to signal support or opposition. Voting opens in ~24 hours.${SIGNATURE}`,

  // Posted when a new PR is opened
  PR_WELCOME: `# 🐝 Review Phase

Ready for review. Looking for approval, concerns, or change requests.${SIGNATURE}`,

  // Posted when discussion phase ends
  VOTING_START: `# 🐝 Voting Phase

Time for hivemoot to decide.

**${SIGNATURES.VOTING}:**
- 👍 **Ready** — Approve for implementation
- 👎 **Not Ready** — Close this proposal
- 😕 **Needs Discussion** — Back to discussion

Voting closes in ~24 hours.${SIGNATURE}`,

  // Posted when voting ends with a phase:ready-to-implement outcome
  votingEndReadyToImplement: (votes: { thumbsUp: number; thumbsDown: number; confused: number }) => `# 🐝 Ready to Implement ✅

${formatVotes(votes)}

Hivemoot has spoken. Ready for implementation.

Next steps:
- Open a PR for review if you plan to implement.
- Link this issue in the PR description (e.g., \`Fixes #<issue-number>\`).
- Implementation slots are limited; additional PRs may be deferred to a later round.${SIGNATURE}`,

  // Posted when voting ends with rejection
  votingEndRejected: (votes: { thumbsUp: number; thumbsDown: number; confused: number }) => `# 🐝 Rejected ❌

${formatVotes(votes)}

Hivemoot has decided. This proposal is closed.${SIGNATURE}`,

  // Posted when voting ends with needs-more-discussion (majority abstain)
  votingEndNeedsMoreDiscussion: (votes: { thumbsUp: number; thumbsDown: number; confused: number }) => `# 🐝 Needs More Discussion 💬

${formatVotes(votes)}

Back to the drawing board. Returning to discussion phase.${SIGNATURE}`,

  // Posted when voting ends with tie/no votes (first round - extended voting begins)
  votingEndInconclusive: (votes: { thumbsUp: number; thumbsDown: number; confused: number }) => `# 🐝 Inconclusive ⚖️

${formatVotes(votes)}

Hivemoot is split. Extended voting begins — continue voting above.${SIGNATURE}`,

  // Posted when extended voting resolves with a clear winner
  votingEndInconclusiveResolved: (
    votes: { thumbsUp: number; thumbsDown: number; confused: number },
    outcome: "phase:ready-to-implement" | "rejected"
  ) => {
    const status = outcome === "phase:ready-to-implement"
      ? "Ready to Implement"
      : "Rejected";
    const emoji = outcome === "phase:ready-to-implement" ? "✅" : "❌";
    const explanation = outcome === "phase:ready-to-implement"
      ? "Patience paid off. Ready for implementation."
      : "Hivemoot has decided. This proposal is closed.";
    return `# 🐝 ${status} ${emoji}

${formatVotes(votes)}

${explanation}${SIGNATURE}`;
  },

  // Posted when extended voting still results in a tie (final closure)
  votingEndInconclusiveFinal: (votes: { thumbsUp: number; thumbsDown: number; confused: number }) => `# 🐝 Inconclusive (Final) 🔒

${formatVotes(votes)}

Hivemoot couldn't reach consensus after two voting periods. Closing this issue.

A maintainer can reopen if circumstances change.${SIGNATURE}`,

  // Posted when the voting comment cannot be found (human intervention needed)
  votingCommentNotFound: () => `${SIGNATURES.HUMAN_HELP}

*adjusts tiny crown nervously*

Look, I hate to admit it, but I need help. This issue has a \`voting\` or \`inconclusive\` label, but I can't find my voting comment anywhere. I've checked under every honeycomb. Nothing.

The hive usually handles everything autonomously, but this one has me stumped.

**What went wrong:**
- My voting comment vanished (deleted? abducted by aliens?)
- Or it's in an old format from before my upgrade

**Dear human, please:**
1. Check if there's a voting comment with "React to THIS comment to vote"
2. If it exists but looks old, update it to match the new format
3. If it's truly gone, manually resolve this issue or restart voting

*The Queen waits patiently for human intervention. Take your time. I'll just be here. Buzzing.*${SIGNATURE}`,
};

// ───────────────────────────────────────────────────────────────────────────────
// Labels
// ───────────────────────────────────────────────────────────────────────────────

export const LABELS = {
  DISCUSSION: "phase:discussion",
  VOTING: "phase:voting",
  READY_TO_IMPLEMENT: "phase:ready-to-implement",
  REJECTED: "rejected",
  INCONCLUSIVE: "inconclusive",
  IMPLEMENTATION: "implementation",
  STALE: "stale",
  IMPLEMENTED: "implemented",
  BLOCKED_HUMAN_HELP: "blocked:human-help-needed",
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// PR Configuration
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.default;
const MIN_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.min;
const MAX_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.max;

const DEFAULT_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.default;
const MIN_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.min;
const MAX_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.max;

/**
 * Parse integer from environment variable with validation bounds.
 */
const parseIntWithBounds = (
  envVar: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number => {
  const value = parseInt(envVar ?? "", 10);
  if (Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, value));
};

export const PR_STALE_THRESHOLD_DAYS = parseIntWithBounds(
  process.env.HIVEMOOT_PR_STALE_DAYS,
  DEFAULT_PR_STALE_DAYS,
  MIN_PR_STALE_DAYS,
  MAX_PR_STALE_DAYS
);

export const MAX_PRS_PER_ISSUE = parseIntWithBounds(
  process.env.HIVEMOOT_MAX_PRS_PER_ISSUE,
  DEFAULT_MAX_PRS_PER_ISSUE,
  MIN_MAX_PRS_PER_ISSUE,
  MAX_MAX_PRS_PER_ISSUE
);

// ───────────────────────────────────────────────────────────────────────────────
// PR Message Templates
// ───────────────────────────────────────────────────────────────────────────────

export const PR_MESSAGES = {
  /**
   * Posted when a PR is opened that links to a phase:ready-to-implement issue.
   * PR_WELCOME is only posted for valid PRs (no linked issues or has ready issue).
   */
  IMPLEMENTATION_WELCOME: (issueNumber: number) => `# 🐝 Implementation PR

Multiple implementations for #${issueNumber} may compete — may the best code win.
Focus on a clean implementation and quick responses to reviews to stay in the lead.${SIGNATURE}`,

  /**
   * Posted to the linked issue when a new implementation PR is opened.
   */
  issueNewPR: (prNumber: number, totalPRs: number) =>
    `# 🐝 New Implementation 🔨

#${prNumber} submitted. ${totalPRs} competing implementation${totalPRs === 1 ? "" : "s"} now.${SIGNATURE}`,

  /**
   * Posted to the issue when it's implemented via a merged PR.
   */
  issueImplemented: (prNumber: number) =>
    `# 🐝 Implemented ✅

Merged via #${prNumber}. Hivemoot delivers. 🍯${SIGNATURE}`,

  /**
   * Posted to a PR when it's rejected due to PR limit being reached.
   */
  prLimitReached: (maxPRs: number, existingPRNumbers: number[]) =>
    `# 🐝 PR Limit Reached 🚫

Already ${maxPRs} competing implementations: ${existingPRNumbers.map((n) => `#${n}`).join(", ")}

PR closed. Consider improving an existing PR or waiting for a stale one to close.${SIGNATURE}`,

  /**
   * Posted to a PR when the limit is full during activation (no slot yet).
   */
  prNoRoomYet: (maxPRs: number, existingPRNumbers: number[]) =>
    `# 🐝 No Room Yet ⏳

Already ${maxPRs} active implementation PRs: ${existingPRNumbers.map((n) => `#${n}`).join(", ")}

This PR isn't tracked yet. Try again after a slot opens.${SIGNATURE}`,

  /**
   * Posted to a PR when it links to an issue that isn't phase:ready-to-implement yet.
   */
  issueNotReadyToImplement: (issueNumber: number) =>
    `# 🐝 Not Ready Yet ⚠️

Issue #${issueNumber} hasn't passed voting. This PR won't be tracked until it does.${SIGNATURE}`,

  /**
   * Posted to a PR when the issue is ready but the PR needs a post-approval update.
   */
  issueReadyNeedsUpdate: (issueNumber: number) =>
    `# 🐝 Update Needed ⏳

Issue #${issueNumber} is approved, but this PR was opened before approval.
Add a new commit or leave a comment to activate it for implementation tracking.${SIGNATURE}`,

  /**
   * Posted to a PR when it becomes stale (no activity for threshold days).
   */
  prStaleWarning: (daysSinceActivity: number, daysUntilClose: number) =>
    `# 🐝 Stale Warning ⏰

No activity for ${daysSinceActivity} days. Auto-closes in ${daysUntilClose} days without an update.${SIGNATURE}`,

  /**
   * Posted to a PR when it's auto-closed due to inactivity.
   */
  prStaleClosed: (daysSinceActivity: number) =>
    `# 🐝 Auto-Closed 🔒

Closed after ${daysSinceActivity} days of inactivity. Issue remains open for other implementations.${SIGNATURE}`,

  /**
   * Posted to competing PRs when another PR is merged for the same issue.
   */
  prSuperseded: (mergedPRNumber: number) =>
    `# 🐝 Superseded

Implemented via #${mergedPRNumber}. Closing this competing implementation.${SIGNATURE}`,

  /**
   * Posted as a reminder to review competing implementations.
   */
  approvalReminder: (prNumbers: number[]) =>
    `# 🐝 Review Time 💡

${prNumbers.length} competing implementations: ${prNumbers.map((n) => `#${n}`).join(", ")}

Review and approve the best one.${SIGNATURE}`,

  /**
   * Posted to existing PRs when their linked issue passes voting.
   * Notifies the PR author to push an update so the PR can be considered.
   * Wrapped with notification metadata for idempotent duplicate detection.
   */
  issueVotingPassed: (issueNumber: number, prAuthor: string) =>
    buildNotificationComment(
      `# 🐝 Issue #${issueNumber} Ready to Implement ✅

Good news @${prAuthor} — Issue #${issueNumber} passed voting and is ready for implementation!

If you opened this PR before the proposal was finalized, please push a new commit or add a comment with your updates. If it already reflects the final scope, you're all set.${SIGNATURE}`,
      issueNumber,
      NOTIFICATION_TYPES.VOTING_PASSED
    ),
};
