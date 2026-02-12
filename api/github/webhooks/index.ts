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
  evaluateMergeReadiness,
} from "../../lib/index.js";
import {
  getLinkedIssues,
} from "../../lib/graphql-queries.js";
import { filterByLabel } from "../../lib/types.js";
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
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      const hasAutomaticDiscussion = repoConfig.governance.proposals.discussion.exits.some(
        (exit) => exit.type === "auto"
      );
      const issueWelcomeMessage =
        hasAutomaticDiscussion ? MESSAGES.ISSUE_WELCOME_VOTING : MESSAGES.ISSUE_WELCOME_MANUAL;

      await governance.startDiscussion({ owner, repo, issueNumber: number }, issueWelcomeMessage);
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
   * Also optimistically removes merge-ready label since new commits reset CI.
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

      // New commits invalidate CI — optimistically remove merge-ready label
      const prRef = { owner, repo, prNumber: number };
      await prs.removeLabel(prRef, LABELS.MERGE_READY);

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

    // PR closed without merge - clean governance labels and recalculate leaderboard
    if (!merged) {
      context.log.info(`PR #${number} closed without merge, cleaning up`);
      try {
        const appId = getAppId();
        const prs = createPROperations(context.octokit, { appId });
        const prRef = { owner, repo, prNumber: number };
        await prs.removeGovernanceLabels(prRef);
        await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);
      } catch (error) {
        context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process closed PR");
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

      // Clean governance labels from the merged PR
      const mergedPrRef = { owner, repo, prNumber: number };
      await prs.removeGovernanceLabels(mergedPrRef);

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
            await prs.removeGovernanceLabels(prRef);
            context.log.info(`Closed competing PR #${competingPR.number}`);
          }
        }
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process merged PR");
      throw error;
    }
  });

  /** Handle PR review submitted - update leaderboard, run intake on approvals, evaluate merge-readiness */
  probotApp.on("pull_request_review.submitted", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const isApproval = context.payload.review.state === REVIEW_STATE.APPROVED;

    context.log.info(`Processing review (${context.payload.review.state}) for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
        // Leaderboard recalc only on approvals
        isApproval
          ? recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number)
          : Promise.resolve(),
      ]);

      // Intake processing only on approvals
      if (isApproval) {
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
      }

      // Merge-readiness evaluation on ALL review states (approval may satisfy threshold,
      // non-approval may invalidate it via changes_requested/dismissal)
      await evaluateMergeReadiness({
        prs,
        ref: { owner, repo, prNumber: number },
        config: repoConfig.governance.pr.mergeReady,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR review");
      throw error;
    }
  });

  /** Handle PR review dismissed - recalculate leaderboard and re-evaluate merge-readiness */
  probotApp.on("pull_request_review.dismissed", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    context.log.info(`Processing dismissed review for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });

      const [, repoConfig] = await Promise.all([
        recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);

      // Dismissed approval may drop below threshold
      await evaluateMergeReadiness({
        prs,
        ref: { owner, repo, prNumber: number },
        config: repoConfig.governance.pr.mergeReady,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to update leaderboard after review dismissal");
      throw error;
    }
  });

  /**
   * Handle label changes — re-evaluate merge-readiness when implementation label is toggled.
   * Adding `implementation` may qualify the PR; removing it should strip `merge-ready`.
   */
  probotApp.on(["pull_request.labeled", "pull_request.unlabeled"], async (context) => {
    if (context.payload.label?.name !== LABELS.IMPLEMENTATION) return;

    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);

      const currentLabels = context.payload.pull_request.labels?.map(
        (l: { name: string }) => l.name
      );

      await evaluateMergeReadiness({
        prs,
        ref: { owner, repo, prNumber: number },
        config: repoConfig.governance.pr.mergeReady,
        trustedReviewers: repoConfig.governance.pr.trustedReviewers,
        currentLabels,
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to evaluate merge-readiness after label change");
      throw error;
    }
  });

  /**
   * Handle check suite completion — re-evaluate merge-readiness for associated PRs.
   * The payload includes pull_requests array with PR numbers affected by this check suite.
   */
  probotApp.on("check_suite.completed", async (context) => {
    const { pull_requests } = context.payload.check_suite;
    if (!pull_requests || pull_requests.length === 0) return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const headSha = context.payload.check_suite.head_sha;

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);

      const errors: Error[] = [];
      for (const pr of pull_requests) {
        try {
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after check_suite in ${fullName}`);
          await evaluateMergeReadiness({
            prs,
            ref: { owner, repo, prNumber: pr.number },
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            headSha,
            log: context.log,
          });
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after check_suite");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after check_suite`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after check_suite");
      }
      throw error;
    }
  });

  /**
   * Handle individual check run completion — re-evaluate merge-readiness.
   * Catches granular CI updates that check_suite.completed may not cover
   * (e.g., individual required checks completing at different times).
   */
  probotApp.on("check_run.completed", async (context) => {
    const { pull_requests } = context.payload.check_run;
    if (!pull_requests || pull_requests.length === 0) return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const headSha = context.payload.check_run.head_sha;

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);

      const errors: Error[] = [];
      for (const pr of pull_requests) {
        try {
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after check_run in ${fullName}`);
          await evaluateMergeReadiness({
            prs,
            ref: { owner, repo, prNumber: pr.number },
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            headSha,
            log: context.log,
          });
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after check_run");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after check_run`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after check_run");
      }
      throw error;
    }
  });

  /**
   * Handle legacy commit status events — re-evaluate merge-readiness.
   * The status event carries a SHA but no direct PR reference.
   * We use the repository's search to find PRs with this HEAD SHA.
   */
  probotApp.on("status", async (context) => {
    const sha = context.payload.sha;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);

      if (!repoConfig.governance.pr.mergeReady) return;

      // Find open PRs with this commit SHA via search
      const { data } = await context.octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      });

      // Filter to PRs whose HEAD matches the status event SHA
      const matchingPRs = data.filter((pr: { head: { sha: string } }) => pr.head.sha === sha);

      const errors: Error[] = [];
      for (const pr of matchingPRs) {
        try {
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after status event in ${fullName}`);
          await evaluateMergeReadiness({
            prs,
            ref: { owner, repo, prNumber: pr.number },
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            headSha: sha,
            log: context.log,
          });
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after status event");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after status event`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after status event");
      }
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
