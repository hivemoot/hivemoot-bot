import { createNodeMiddleware, createProbot, Probot } from "probot";
import type { IncomingMessage, ServerResponse } from "http";
import {
  LABELS,
  MESSAGES,
  PR_MESSAGES,
} from "../../config.js";
import {
  createIssueOperations,
  createPROperations,
  createGovernanceService,
  loadRepositoryConfig,
  getOpenPRsForIssue,
} from "../../lib/index.js";
import {
  getLinkedIssues,
} from "../../lib/graphql-queries.js";
import { filterByLabel } from "../../lib/types.js";
import type { LinkedIssue } from "../../lib/types.js";
import { validateEnv, getAppId } from "../../lib/env-validation.js";
import {
  processImplementationIntake,
  recalculateLeaderboardForPR,
} from "../../lib/implementation-intake.js";

/**
 * Queen Bot - Hivemoot Governance Automation
 *
 * Handles GitHub webhooks for AI agent community governance:
 * - New issues: Add 'phase:discussion' label + welcome message
 * - New PRs: Post review checklist
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** GitHub review states */
const REVIEW_STATE = {
  APPROVED: "approved",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Repository context extracted from webhook payloads */
interface RepoContext {
  owner: string;
  repo: string;
  fullName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Extract repository context from webhook payload */
function getRepoContext(repository: { owner: { login: string }; name: string; full_name: string }): RepoContext {
  return {
    owner: repository.owner.login,
    repo: repository.name,
    fullName: repository.full_name,
  };
}

function app(probotApp: Probot): void {
  probotApp.log.info("Queen bot initialized");

  probotApp.on("issues.opened", async (context) => {
    const { number } = context.payload.issue;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing issue #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const governance = createGovernanceService(issues);

      await governance.startDiscussion({ owner, repo, issueNumber: number });
    } catch (error) {
      context.log.error({ err: error, issue: number, repo: fullName }, "Failed to process issue");
      throw error;
    }
  });

  probotApp.on("pull_request.opened", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);

      // Unlinked PRs get a warning; linked PRs are handled by processImplementationIntake
      if (linkedIssues.length === 0) {
        await issues.comment({ owner, repo, issueNumber: number }, MESSAGES.PR_NO_LINKED_ISSUE);
      }

      await processImplementationIntake({
        octokit: context.octokit,
        issues,
        prs,
        log: context.log,
        owner,
        repo,
        prNumber: number,
        linkedIssues,
        trigger: "opened",
        maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        intake: repoConfig.governance.pr.intake,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR");
      throw error;
    }
  });

  /**
   * Handle PR updates (new commits) to activate pre-ready PRs.
   */
  probotApp.on("pull_request.synchronize", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR update #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);

      await processImplementationIntake({
        octokit: context.octokit,
        issues,
        prs,
        log: context.log,
        owner,
        repo,
        prNumber: number,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        intake: repoConfig.governance.pr.intake,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR update");
      throw error;
    }
  });

  /**
   * Handle PR description edits to pick up newly added closing keywords.
   */
  probotApp.on("pull_request.edited", async (context) => {
    // Only body edits can change closing keywords — skip title/base changes
    if (!context.payload.changes?.body) {
      return;
    }

    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR edit #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);

      await processImplementationIntake({
        octokit: context.octokit,
        issues,
        prs,
        log: context.log,
        owner,
        repo,
        prNumber: number,
        linkedIssues,
        trigger: "edited",
        maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        intake: repoConfig.governance.pr.intake,
        editedAt: new Date(context.payload.pull_request.updated_at),
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR edit");
      throw error;
    }
  });

  /**
   * Handle PR comments to activate pre-ready PRs.
   */
  probotApp.on("issue_comment.created", async (context) => {
    const { issue, comment } = context.payload;
    if (!issue.pull_request) {
      return;
    }

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const prNumber = issue.number;

    try {
      const appId = getAppId();
      if (comment.performed_via_github_app?.id === appId) {
        return;
      }

      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, prNumber),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);

      await processImplementationIntake({
        octokit: context.octokit,
        issues,
        prs,
        log: context.log,
        owner,
        repo,
        prNumber,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        intake: repoConfig.governance.pr.intake,
      });
    } catch (error) {
      context.log.error({ err: error, pr: prNumber, repo: fullName }, "Failed to process PR comment");
      throw error;
    }
  });

  /**
   * Handle PR closed - if merged, close competing PRs and mark issue as implemented.
   * If closed without merge, recalculate leaderboard to remove the closed PR.
   */
  probotApp.on("pull_request.closed", async (context) => {
    const { number, merged } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    // PR closed without merge - just recalculate leaderboard
    if (!merged) {
      context.log.info(`PR #${number} closed without merge, recalculating leaderboard`);
      try {
        await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);
      } catch (error) {
        context.log.error({ err: error, pr: number, repo: fullName }, "Failed to recalculate leaderboard after PR close");
        throw error;
      }
      return;
    }

    // PR merged - mark linked issues as implemented and close competing PRs
    context.log.info(`Processing merged PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const linkedIssues = await getLinkedIssues(context.octokit, owner, repo, number);

      for (const linkedIssue of filterByLabel(linkedIssues, LABELS.READY_TO_IMPLEMENT)) {
        const issueRef = { owner, repo, issueNumber: linkedIssue.number };

        // Transition issue to implemented state
        await issues.removeLabel(issueRef, LABELS.READY_TO_IMPLEMENT);
        await issues.addLabels(issueRef, [LABELS.IMPLEMENTED]);
        await issues.close(issueRef, "completed");
        await issues.comment(issueRef, PR_MESSAGES.issueImplemented(number));

        // Close competing PRs
        const competingPRs = await getOpenPRsForIssue(context.octokit, owner, repo, linkedIssue.number);
        for (const competingPR of competingPRs) {
          if (competingPR.number !== number) {
            const prRef = { owner, repo, prNumber: competingPR.number };
            await prs.comment(prRef, PR_MESSAGES.prSuperseded(number));
            await prs.close(prRef);
            context.log.info(`Closed competing PR #${competingPR.number}`);
          }
        }
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process merged PR");
      throw error;
    }
  });

  /** Handle PR review submitted - update leaderboard and run intake on approvals */
  probotApp.on("pull_request_review.submitted", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    if (context.payload.review.state !== REVIEW_STATE.APPROVED) {
      return;
    }

    context.log.info(`Processing approval for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
        recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number),
      ]);

      await processImplementationIntake({
        octokit: context.octokit,
        issues,
        prs,
        log: context.log,
        owner,
        repo,
        prNumber: number,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        intake: repoConfig.governance.pr.intake,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR review");
      throw error;
    }
  });

  /** Handle PR review dismissed - recalculate leaderboard when approvals are revoked */
  probotApp.on("pull_request_review.dismissed", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    context.log.info(`Processing dismissed review for PR #${number} in ${fullName}`);

    try {
      await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to update leaderboard after review dismissal");
      throw error;
    }
  });
}

const probot = createProbot();
const middleware = createNodeMiddleware(app, {
  probot,
  webhooksPath: "/api/github/webhooks",
});

/**
 * Vercel serverless function handler.
 *
 * GET requests return health status with configuration validation.
 * POST requests are forwarded to Probot middleware for webhook processing.
 *
 * Security: Both GET and POST validate WEBHOOK_SECRET is configured.
 * Probot then verifies webhook signatures - unsigned payloads are rejected.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  // Validate environment for all requests (fail-closed guard)
  const validation = validateEnv(true);

  if (req.method === "GET") {
    res.statusCode = validation.valid ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: validation.valid ? "ok" : "misconfigured",
        bot: "Queen",
      })
    );
    return;
  }

  // Reject webhooks if environment is misconfigured
  if (!validation.valid) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Webhook processing unavailable" }));
    return;
  }

  middleware(req, res);
}
