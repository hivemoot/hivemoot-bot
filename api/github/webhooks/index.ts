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
  createLeaderboardService,
  createGovernanceService,
  loadRepositoryConfig,
  getOpenPRsForIssue,
} from "../../lib/index.js";
import {
  getLinkedIssues,
  type GraphQLClient,
} from "../../lib/graphql-queries.js";
import type { LinkedIssue, PRWithApprovals, PullRequest } from "../../lib/types.js";
import { hasLabel } from "../../lib/types.js";
import { validateEnv, getAppId } from "../../lib/env-validation.js";
import { logger } from "../../lib/logger.js";

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

/** Max concurrent API calls when fetching PR approval counts */
const APPROVAL_FETCH_CONCURRENCY = 3;

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

type IntakeTrigger = "opened" | "updated";

/**
 * Combined client interface for leaderboard recalculation.
 * Probot's Context.octokit satisfies all these requirements.
 */
type LeaderboardRecalcClient = GraphQLClient &
  Parameters<typeof createLeaderboardService>[0] &
  Parameters<typeof createPROperations>[0];

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

/** Filter linked issues to only those in phase:ready-to-implement */
function filterReadyIssues(issues: LinkedIssue[]): LinkedIssue[] {
  return issues.filter((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
}

/**
 * Build a map of ready issue numbers to active implementation PRs.
 *
 * Uses PR-side linking (closingIssuesReferences) to avoid relying on
 * cross-reference timeline events that may lag behind PR creation.
 */
async function getImplementationPRsByIssue(params: {
  octokit: GraphQLClient;
  prs: ReturnType<typeof createPROperations>;
  owner: string;
  repo: string;
  issueNumbers: number[];
  ensurePRNumber?: number;
  linkedIssuesByPRNumber?: Map<number, LinkedIssue[]>;
}): Promise<Map<number, PullRequest[]>> {
  const {
    octokit,
    prs,
    owner,
    repo,
    issueNumbers,
    ensurePRNumber,
    linkedIssuesByPRNumber,
  } = params;

  const issueNumberSet = new Set(issueNumbers);
  const results = new Map<number, PullRequest[]>();

  for (const issueNumber of issueNumbers) {
    results.set(issueNumber, []);
  }

  if (issueNumberSet.size === 0) {
    return results;
  }

  const implementationPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
  const candidateNumbers = new Set(implementationPRs.map((pr) => pr.number));

  if (ensurePRNumber !== undefined && !candidateNumbers.has(ensurePRNumber)) {
    const labels = await prs.getLabels({ owner, repo, prNumber: ensurePRNumber });
    if (labels.includes(LABELS.IMPLEMENTATION)) {
      candidateNumbers.add(ensurePRNumber);
      logger.debug(`ensurePR #${ensurePRNumber}: added via direct label check (not yet indexed)`);
    }
  }

  const linkedIssuesCache = linkedIssuesByPRNumber ?? new Map<number, LinkedIssue[]>();
  const prDetailsCache = new Map<number, PullRequest>();
  const candidates = Array.from(candidateNumbers);

  logger.debug(
    `Found ${candidates.length} candidate implementation PRs for issues [${issueNumbers.join(", ")}]`
  );

  const getPullRequestSummary = async (prNumber: number): Promise<PullRequest | null> => {
    const cached = prDetailsCache.get(prNumber);
    if (cached) {
      return cached;
    }

    const details = await prs.get({ owner, repo, prNumber });
    const normalizedState =
      details.merged ? "MERGED" : details.state.toUpperCase() === "OPEN" ? "OPEN" : "CLOSED";

    if (normalizedState !== "OPEN") {
      return null;
    }

    const summary: PullRequest = {
      number: prNumber,
      title: "",
      state: normalizedState,
      author: { login: details.author },
    };

    prDetailsCache.set(prNumber, summary);
    return summary;
  };

  for (let i = 0; i < candidates.length; i += APPROVAL_FETCH_CONCURRENCY) {
    const batch = candidates.slice(i, i + APPROVAL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (prNumber) => {
        try {
          const cachedLinkedIssues = linkedIssuesCache.get(prNumber);
          const linkedIssues =
            cachedLinkedIssues ?? (await getLinkedIssues(octokit, owner, repo, prNumber));

          if (!cachedLinkedIssues) {
            linkedIssuesCache.set(prNumber, linkedIssues);
          }

          const linkedIssueNumbers = linkedIssues
            .map((issue) => issue.number)
            .filter((number) => issueNumberSet.has(number));

          if (linkedIssueNumbers.length === 0) {
            return null;
          }

          const prSummary = await getPullRequestSummary(prNumber);
          if (!prSummary) {
            return null;
          }

          return { prSummary, linkedIssueNumbers };
        } catch (error) {
          // PR may have been deleted or is inaccessible — skip it rather than
          // crashing the entire batch and losing all other candidates.
          logger.warn(
            `Skipping candidate PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
          );
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (!result) {
        continue;
      }

      for (const issueNumber of result.linkedIssueNumbers) {
        results.get(issueNumber)?.push(result.prSummary);
      }
    }
  }

  return results;
}

/**
 * Determine if a PR is eligible for intake based on activity after the ready label.
 *
 * Anti-gaming guard: requires PR activity (commit or human comment) to occur
 * AFTER the issue received the phase:ready-to-implement label. This prevents
 * agents from pre-creating empty/skeleton PRs during discussion or voting
 * to automatically claim implementation slots when voting passes.
 *
 * When voting passes, close-discussions.ts notifies existing PRs to push
 * an update — but does not auto-tag them. The PR author must demonstrate
 * real post-approval work before activation.
 */
function isActivationAfterReady(activationDate: Date, readyAt: Date): boolean {
  return activationDate.getTime() >= readyAt.getTime();
}

/**
 * Fetch approval counts for PRs with concurrency limiting.
 * Processes PRs in batches to avoid rate limiting.
 */
async function fetchApprovalScores(
  prs: ReturnType<typeof createPROperations>,
  competingPRs: PullRequest[],
  owner: string,
  repo: string
): Promise<PRWithApprovals[]> {
  const scores: PRWithApprovals[] = [];

  for (let i = 0; i < competingPRs.length; i += APPROVAL_FETCH_CONCURRENCY) {
    const batch = competingPRs.slice(i, i + APPROVAL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author.login,
        approvals: await prs.getApprovalCount({ owner, repo, prNumber: pr.number }),
      }))
    );
    scores.push(...batchResults);
  }

  return scores;
}

/**
 * Intake a PR as an implementation when it becomes eligible.
 *
 * Eligibility rules:
 * - Issue must be phase:ready-to-implement
 * - PR must have activity (comment or commit) after the ready label time
 * - Only intake if there is room under the per-repo maxPRsPerIssue
 */
export async function processImplementationIntake(params: {
  octokit: GraphQLClient;
  issues: ReturnType<typeof createIssueOperations>;
  prs: ReturnType<typeof createPROperations>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  owner: string;
  repo: string;
  prNumber: number;
  linkedIssues: LinkedIssue[];
  trigger: IntakeTrigger;
  maxPRsPerIssue: number;
}): Promise<void> {
  const {
    octokit,
    issues,
    prs,
    log,
    owner,
    repo,
    prNumber,
    linkedIssues,
    trigger,
    maxPRsPerIssue,
  } = params;

  if (linkedIssues.length === 0) {
    return;
  }

  const prRef = { owner, repo, prNumber };
  const [prDetails, prLabels] = await Promise.all([
    prs.get(prRef),
    prs.getLabels(prRef),
  ]);

  // Avoid re-processing PRs already accepted as implementations
  if (prLabels.includes(LABELS.IMPLEMENTATION)) {
    return;
  }

  const activationDate = await prs.getActivationDate(prRef, prDetails.createdAt);
  const readyIssues = filterReadyIssues(linkedIssues);
  const activeImplementationPRsByIssue =
    readyIssues.length > 0
      ? await getImplementationPRsByIssue({
          octokit,
          prs,
          owner,
          repo,
          issueNumbers: readyIssues.map((issue) => issue.number),
        })
      : new Map<number, PullRequest[]>();

  let welcomed = false;

  for (const linkedIssue of linkedIssues) {
    if (!hasLabel(linkedIssue, LABELS.READY_TO_IMPLEMENT)) {
      if (trigger === "opened") {
        await prs.comment(prRef, PR_MESSAGES.issueNotReadyToImplement(linkedIssue.number));
      }
      continue;
    }

    const issueRef = { owner, repo, issueNumber: linkedIssue.number };
    const readyAt = await issues.getLabelAddedTime(issueRef, LABELS.READY_TO_IMPLEMENT);

    if (!readyAt) {
      log.warn(
        `Ready label time missing for issue #${linkedIssue.number}; skipping PR #${prNumber}`
      );
      continue;
    }

    if (!isActivationAfterReady(activationDate, readyAt)) {
      if (trigger === "opened") {
        await prs.comment(prRef, PR_MESSAGES.issueReadyNeedsUpdate(linkedIssue.number));
      }
      continue;
    }

    const activePRs = activeImplementationPRsByIssue.get(linkedIssue.number) ?? [];
    const otherActivePRs = activePRs.filter((pr) => pr.number !== prNumber);
    const totalPRCountIfAccepted = otherActivePRs.length + 1;

    if (totalPRCountIfAccepted > maxPRsPerIssue) {
      if (trigger === "opened") {
        await prs.comment(
          prRef,
          PR_MESSAGES.prLimitReached(
            maxPRsPerIssue,
            otherActivePRs.map((pr) => pr.number)
          )
        );
        await prs.close(prRef);
      } else {
        await prs.comment(
          prRef,
          PR_MESSAGES.prNoRoomYet(
            maxPRsPerIssue,
            otherActivePRs.map((pr) => pr.number)
          )
        );
      }
      return;
    }

    await prs.addLabels(prRef, [LABELS.IMPLEMENTATION]);
    await recalculateLeaderboardForPR(octokit, log, owner, repo, prNumber);

    if (!welcomed) {
      await prs.comment(prRef, PR_MESSAGES.IMPLEMENTATION_WELCOME(linkedIssue.number));
      welcomed = true;
    }

    await issues.comment(
      issueRef,
      PR_MESSAGES.issueNewPR(prNumber, totalPRCountIfAccepted)
    );
  }
}

/**
 * Recalculate leaderboard for all linked issues of a PR.
 * Called when approval counts change (new approval, dismissal) or PR is closed.
 */
export async function recalculateLeaderboardForPR(
  octokit: LeaderboardRecalcClient,
  log: { info: (msg: string) => void },
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const appId = getAppId();
  const leaderboard = createLeaderboardService(octokit, { appId });
  const prs = createPROperations(octokit, { appId });

  const linkedIssues = await getLinkedIssues(octokit, owner, repo, prNumber);
  const readyIssues = filterReadyIssues(linkedIssues);

  if (readyIssues.length === 0) {
    return;
  }

  const linkedIssuesCache = new Map<number, LinkedIssue[]>();
  linkedIssuesCache.set(prNumber, linkedIssues);

  const activeImplementationPRsByIssue = await getImplementationPRsByIssue({
    octokit,
    prs,
    owner,
    repo,
    issueNumbers: readyIssues.map((issue) => issue.number),
    ensurePRNumber: prNumber,
    linkedIssuesByPRNumber: linkedIssuesCache,
  });

  for (const linkedIssue of readyIssues) {
    const activePRs = activeImplementationPRsByIssue.get(linkedIssue.number) ?? [];
    const scores = await fetchApprovalScores(prs, activePRs, owner, repo);

    await leaderboard.upsertLeaderboard(
      { owner, repo, issueNumber: linkedIssue.number },
      scores
    );

    log.info(`Updated leaderboard for issue #${linkedIssue.number} with ${scores.length} active PRs`);
  }
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

      // Welcome PRs that are standalone or linked to ready-to-implement issues
      const shouldWelcome = linkedIssues.length === 0 || filterReadyIssues(linkedIssues).length > 0;
      if (shouldWelcome) {
        await issues.comment({ owner, repo, issueNumber: number }, MESSAGES.PR_WELCOME);
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
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR update");
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

      for (const linkedIssue of filterReadyIssues(linkedIssues)) {
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

  /** Handle PR review submitted - update leaderboard on approvals */
  probotApp.on("pull_request_review.submitted", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    if (context.payload.review.state !== REVIEW_STATE.APPROVED) {
      return;
    }

    context.log.info(`Processing approval for PR #${number} in ${fullName}`);

    try {
      await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to update leaderboard");
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
