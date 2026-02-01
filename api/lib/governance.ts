/**
 * Governance Operations
 *
 * High-level business logic for issue governance phases:
 * - Discussion → Voting transition
 * - Voting outcome determination
 *
 * This module is agnostic to the GitHub client implementation,
 * making it reusable across webhooks and scheduled scripts.
 */

import { LABELS, MESSAGES, SIGNATURE } from "../config.js";
import {
  buildVotingComment,
  buildHumanHelpComment,
  SIGNATURES,
  ERROR_CODES,
} from "./bot-comments.js";
import type { IssueOperations } from "./github-client.js";
import { createModelFromEnv } from "./llm/provider.js";
import { DiscussionSummarizer, formatVotingMessage } from "./llm/summarizer.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import type {
  IssueRef,
  VoteCounts,
  VotingOutcome,
  LockReason,
} from "./types.js";

/**
 * Configuration for GovernanceService
 */
export interface GovernanceServiceConfig {
  logger?: Logger;
}

/**
 * Configuration for a voting outcome transition.
 * Defines the label, message, and state changes to apply.
 */
interface OutcomeTransitionConfig {
  /** Label to apply after transition */
  label: string;
  /** Message to post on the issue */
  message: string;
  /** Whether to close the issue */
  close: boolean;
  /** Reason for closing (only used when close is true) */
  closeReason?: "completed" | "not_planned";
  /** Whether to lock the issue */
  lock: boolean;
  /** Reason for locking (only used when lock is true) */
  lockReason?: LockReason;
  /** Whether to unlock the issue (mutually exclusive with lock) */
  unlock?: boolean;
}

/**
 * Create GovernanceService with validated dependencies.
 *
 * This factory function ensures consistent construction across webhooks
 * and scheduled scripts, following the pattern of other service factories.
 *
 * @param issues - IssueOperations instance for GitHub API calls
 * @param config - Optional configuration including custom logger
 * @throws Error if issues is null/undefined
 */
export function createGovernanceService(
  issues: IssueOperations,
  config?: GovernanceServiceConfig,
): GovernanceService {
  if (!issues) {
    throw new Error(
      "Invalid IssueOperations: expected a valid IssueOperations instance",
    );
  }
  return new GovernanceService(issues, config?.logger);
}

/**
 * Governance service for managing issue lifecycle phases
 */
export class GovernanceService {
  private logger: Logger;

  constructor(
    private issues: IssueOperations,
    logger?: Logger,
  ) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Start the discussion phase for a new issue
   */
  async startDiscussion(ref: IssueRef): Promise<void> {
    await Promise.all([
      this.issues.addLabels(ref, [LABELS.DISCUSSION]),
      this.issues.comment(ref, MESSAGES.ISSUE_WELCOME),
    ]);
  }

  /**
   * Transition from discussion phase to voting phase.
   *
   * Attempts to generate an LLM summary of the discussion for the voting
   * message. Falls back to the generic VOTING_START message if:
   * - LLM is not configured
   * - LLM API fails
   * - Summary generation fails for any reason
   *
   * Appends hidden metadata to track the voting cycle number, enabling
   * correct vote counting when issues return from needs-more-discussion.
   */
  async transitionToVoting(ref: IssueRef): Promise<void> {
    // Calculate the next cycle number based on existing voting comments
    const cycle = await this.calculateVotingCycle(ref);
    const votingMessage = await this.generateVotingMessage(ref);

    // Build complete voting comment with embedded metadata
    const commentBody = buildVotingComment(
      votingMessage,
      ref.issueNumber,
      cycle,
    );

    await this.issues.transition(ref, {
      removeLabel: LABELS.DISCUSSION,
      addLabel: LABELS.VOTING,
      comment: commentBody,
    });
  }

  /**
   * Calculate the voting cycle number for a new voting comment.
   *
   * Returns 1 for the first voting cycle, 2 for the second (after
   * needs-more-discussion), etc.
   */
  private async calculateVotingCycle(ref: IssueRef): Promise<number> {
    const existingCount = await this.issues.countVotingComments(ref);
    return existingCount + 1;
  }

  /**
   * Generate the voting message, with LLM summary if available.
   * Falls back to generic message on any failure.
   */
  private async generateVotingMessage(ref: IssueRef): Promise<string> {
    // Validate LLM is fully configured (including API key) BEFORE any GitHub calls.
    // createModelFromEnv() returns null if provider/model not set, or throws if API key missing.
    let modelResult: ReturnType<typeof createModelFromEnv>;
    try {
      modelResult = createModelFromEnv();
    } catch (error) {
      // API key missing - log at debug level since this is a config issue, not a runtime error
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `LLM not fully configured for issue #${ref.issueNumber}: ${message}`,
      );
      return MESSAGES.VOTING_START;
    }

    if (!modelResult) {
      this.logger.debug(
        `LLM not configured, using generic voting message for issue #${ref.issueNumber}`,
      );
      return MESSAGES.VOTING_START;
    }

    try {
      // Fetch issue context for summarization (only after LLM validation passes)
      const context = await this.issues.getIssueContext(ref);

      // Attempt LLM summarization with pre-validated model
      const summarizer = new DiscussionSummarizer({ logger: this.logger });
      const result = await summarizer.summarize(context, modelResult);

      if (result.success) {
        this.logger.info(`Generated LLM summary for issue #${ref.issueNumber}`);
        return formatVotingMessage(
          result.summary,
          context.title,
          SIGNATURE,
          SIGNATURES.VOTING,
        );
      }

      // Summarization failed, use generic message
      this.logger.debug(
        `Using generic voting message for issue #${ref.issueNumber}: ${result.reason}`,
      );
      return MESSAGES.VOTING_START;
    } catch (error) {
      // Any unexpected error, fail open with generic message
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to generate voting summary for issue #${ref.issueNumber}: ${message}. Using generic message.`,
      );
      return MESSAGES.VOTING_START;
    }
  }

  /**
   * End voting and apply the outcome.
   * Votes are counted from the bot's voting comment reactions.
   *
   * If the voting comment is not found, posts a human help request
   * and returns "skipped" to allow the script to continue processing
   * other issues.
   */
  async endVoting(ref: IssueRef): Promise<VotingOutcome> {
    const commentId = await this.issues.findVotingCommentId(ref);

    if (!commentId) {
      await this.handleMissingVotingComment(ref);
      return "skipped";
    }

    const votes = await this.issues.getVoteCountsFromComment(ref, commentId);
    const outcome = this.determineOutcome(votes);

    // Type excludes "skipped" since determineOutcome() never returns it
    const outcomeConfig: Record<
      Exclude<VotingOutcome, "skipped">,
      OutcomeTransitionConfig
    > = {
      "phase:ready-to-implement": {
        label: LABELS.READY_TO_IMPLEMENT,
        message: MESSAGES.votingEndReadyToImplement(votes),
        close: false,
        // Keep unlocked so the bot can post/update additional (such as leaderboard) comments on the issue.
        lock: false,
      },
      rejected: {
        label: LABELS.REJECTED,
        message: MESSAGES.votingEndRejected(votes),
        close: true,
        lock: true,
      },
      inconclusive: {
        label: LABELS.INCONCLUSIVE,
        message: MESSAGES.votingEndInconclusive(votes),
        close: false,
        lock: false,
      },
      "needs-more-discussion": {
        label: LABELS.DISCUSSION,
        message: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      },
    };

    const config = outcomeConfig[outcome];

    await this.applyTransition(ref, LABELS.VOTING, config);

    return outcome;
  }

  /**
   * Resolve an inconclusive issue after extended voting period.
   *
   * Re-evaluates votes and applies the same logic as initial voting:
   * - thumbsUp > thumbsDown → ready-to-implement (open, unlocked)
   * - thumbsDown > thumbsUp → rejected (closed, locked)
   * - needs-more-discussion → return to discussion (open, unlocked)
   * - Still tied → final inconclusive (closed, locked)
   *
   * If the voting comment is not found, posts a human help request
   * and returns "skipped" to allow the script to continue processing.
   */
  async resolveInconclusive(ref: IssueRef): Promise<VotingOutcome> {
    const commentId = await this.issues.findVotingCommentId(ref);

    if (!commentId) {
      await this.handleMissingVotingComment(ref);
      return "skipped";
    }

    const votes = await this.issues.getVoteCountsFromComment(ref, commentId);
    const outcome = this.determineOutcome(votes);

    // Configuration for each possible outcome after extended voting
    // Type excludes "skipped" since determineOutcome() never returns it
    const outcomeConfig: Record<
      Exclude<VotingOutcome, "skipped">,
      OutcomeTransitionConfig
    > = {
      "phase:ready-to-implement": {
        label: LABELS.READY_TO_IMPLEMENT,
        message: MESSAGES.votingEndInconclusiveResolved(
          votes,
          "phase:ready-to-implement",
        ),
        close: false,
        // Keep unlocked so the bot can post/update leaderboard comments on the issue.
        lock: false,
      },
      rejected: {
        label: LABELS.REJECTED,
        message: MESSAGES.votingEndInconclusiveResolved(votes, "rejected"),
        close: true,
        lock: true,
      },
      inconclusive: {
        label: LABELS.INCONCLUSIVE,
        message: MESSAGES.votingEndInconclusiveFinal(votes),
        close: true,
        lock: true,
      },
      "needs-more-discussion": {
        label: LABELS.DISCUSSION,
        message: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      },
    };

    const config = outcomeConfig[outcome];

    await this.applyTransition(ref, LABELS.INCONCLUSIVE, config);

    return outcome;
  }

  /**
   * Apply a transition with the given configuration.
   * Centralizes the transition options construction to reduce duplication.
   */
  private async applyTransition(
    ref: IssueRef,
    removeLabel: string,
    config: OutcomeTransitionConfig,
  ): Promise<void> {
    await this.issues.transition(ref, {
      removeLabel,
      addLabel: config.label,
      comment: config.message,
      close: config.close,
      ...(config.close && { closeReason: "not_planned" as const }),
      lock: config.lock,
      ...(config.lock && { lockReason: "resolved" as const }),
      ...(config.unlock && { unlock: true }),
    });
  }

  /**
   * Handle missing voting comment by posting a human help request.
   * Idempotent - checks if warning was already posted to avoid duplicates.
   */
  private async handleMissingVotingComment(ref: IssueRef): Promise<void> {
    const errorCode = ERROR_CODES.VOTING_COMMENT_NOT_FOUND;

    // Check if we already posted this error (idempotent)
    const alreadyPosted = await this.issues.hasHumanHelpComment(ref, errorCode);
    if (alreadyPosted) {
      this.logger.info(
        `Human help comment already posted for issue #${ref.issueNumber}, skipping`,
      );
      return;
    }

    // Build and post the warning comment
    const errorComment = buildHumanHelpComment(
      MESSAGES.votingCommentNotFound(),
      ref.issueNumber,
      errorCode,
    );
    await this.issues.comment(ref, errorComment);

    // Add the blocked label to make the issue visible in issue lists
    // Note: Label addition is best-effort - if the label doesn't exist in the repo,
    // we log a warning but don't fail the operation (the comment is the critical part)
    try {
      await this.issues.addLabels(ref, [LABELS.BLOCKED_HUMAN_HELP]);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to add ${LABELS.BLOCKED_HUMAN_HELP} label to issue #${ref.issueNumber}: ${errorMsg}`,
      );
    }

    this.logger.warn(
      `Posted human help request for issue #${ref.issueNumber}: ${errorCode}`,
    );
  }

  /**
   * Determine voting outcome based on reaction counts.
   *
   * Priority order:
   * 1. needs-more-discussion: 😕 > (👍 + 👎) - majority wants more discussion
   * 2. ready-to-implement: 👍 > 👎
   * 3. rejected: 👎 > 👍
   * 4. inconclusive: 👍 = 👎 (triggers extended voting)
   *
   * Note: "skipped" is never returned here - it's only used when the voting
   * comment is missing (handled before this method is called).
   */
  private determineOutcome(
    votes: VoteCounts,
  ): Exclude<VotingOutcome, "skipped"> {
    // Check for majority abstain first - community needs more discussion
    if (votes.confused > votes.thumbsUp + votes.thumbsDown) {
      return "needs-more-discussion";
    }
    if (votes.thumbsUp > votes.thumbsDown) {
      return "phase:ready-to-implement";
    }
    if (votes.thumbsDown > votes.thumbsUp) {
      return "rejected";
    }
    return "inconclusive";
  }
}
