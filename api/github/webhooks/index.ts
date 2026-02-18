import { createNodeMiddleware, createProbot, Probot } from "probot";
import type { IncomingMessage, ServerResponse } from "http";
import {
  LABELS,
  MESSAGES,
  PR_MESSAGES,
  isLabelMatch,
} from "../../config.js";
import {
  createIssueOperations,
  createPROperations,
  createRepositoryLabelService,
  createGovernanceService,
  loadRepositoryConfig,
  getOpenPRsForIssue,
  evaluateMergeReadiness,
} from "../../lib/index.js";
import {
  getLinkedIssues,
} from "../../lib/graphql-queries.js";
import { hasSameRepoClosingKeywordRef } from "../../lib/closing-keywords.js";
import { filterByLabel } from "../../lib/types.js";
import { validateEnv, getAppId } from "../../lib/env-validation.js";
import {
  processImplementationIntake,
  recalculateLeaderboardForPR,
} from "../../lib/implementation-intake.js";
import { parseCommand, executeCommand } from "../../lib/commands/index.js";
import { getLLMReadiness } from "../../lib/llm/provider.js";

/**
 * Queen Bot - Hivemoot Governance Automation
 *
 * Handles GitHub webhooks for AI agent community governance:
 * - New issues: Add `hivemoot:discussion` label + welcome message
 * - New PRs: Link validation, implementation intake, and leaderboard tracking
 * - Issue/PR comments: @mention + /command dispatch and PR intake updates
 * - PR lifecycle: Merge outcomes, competing PR closure, stale management
 * - Reviews & CI: Leaderboard recalculation, merge-readiness evaluation
 * - Installation: Label bootstrapping for new repositories
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

interface LabelBootstrapContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

interface LabelBootstrapSummary {
  reposProcessed: number;
  reposFailed: number;
  labelsCreated: number;
  labelsRenamed: number;
  labelsUpdated: number;
  labelsSkipped: number;
}

interface InstallationRepoPayload {
  owner?: { login?: string } | null;
  name: string;
  full_name: string;
}

interface InstallationRepoListClient {
  rest: {
    apps: {
      listReposAccessibleToInstallation: (params: {
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: {
          repositories?: InstallationRepoPayload[];
        };
      }>;
    };
  };
}

const INSTALLATION_REPO_PAGE_SIZE = 100;
const PR_OPENED_LINK_RETRY_DELAY_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Check if a PR targets the repository's default branch */
function targetsDefaultBranch(
  pullRequest: { base: { ref: string } },
  repository: { default_branch?: string },
): boolean {
  return !repository.default_branch || pullRequest.base.ref === repository.default_branch;
}

/** Extract repository context from webhook payload */
function getRepoContext(repository: InstallationRepoPayload): RepoContext {
  const ownerFromFullName = repository.full_name.split("/")[0];
  const owner = repository.owner?.login ?? ownerFromFullName;
  if (!owner) {
    throw new Error(`Unable to determine repository owner from '${repository.full_name}'`);
  }
  return {
    owner,
    repo: repository.name,
    fullName: repository.full_name,
  };
}

function hasInstallationRepoListClient(octokit: unknown): octokit is InstallationRepoListClient {
  if (typeof octokit !== "object" || octokit === null) {
    return false;
  }

  const client = octokit as {
    rest?: {
      apps?: {
        listReposAccessibleToInstallation?: unknown;
      };
    };
  };

  return typeof client.rest?.apps?.listReposAccessibleToInstallation === "function";
}

async function listAccessibleInstallationRepositories(
  octokit: unknown,
  eventName: string
): Promise<InstallationRepoPayload[]> {
  if (!hasInstallationRepoListClient(octokit)) {
    throw new Error(
      `[${eventName}] Unable to list installation repositories: missing apps.listReposAccessibleToInstallation`
    );
  }

  const repositories: InstallationRepoPayload[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: INSTALLATION_REPO_PAGE_SIZE,
      page,
    });

    const pageRepositories = Array.isArray(data.repositories) ? data.repositories : [];
    repositories.push(...pageRepositories);

    if (pageRepositories.length < INSTALLATION_REPO_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return repositories;
}

async function ensureLabelsForRepositories(
  context: LabelBootstrapContext,
  repositories: readonly InstallationRepoPayload[] | undefined,
  eventName: string
): Promise<void> {
  const payloadRepositories = repositories ?? [];
  let targetRepositories = payloadRepositories;

  if (targetRepositories.length === 0) {
    context.log.info(
      `[${eventName}] Repository list missing from payload; fetching installation repositories`
    );
    targetRepositories = await listAccessibleInstallationRepositories(context.octokit, eventName);
  }

  if (targetRepositories.length === 0) {
    context.log.info(`[${eventName}] No installation repositories available; skipping label bootstrap`);
    context.log.info(
      `[${eventName}] Label bootstrap summary: reposProcessed=0, reposFailed=0, labelsCreated=0, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
    );
    return;
  }

  const labelService = createRepositoryLabelService(context.octokit);
  const errors: Error[] = [];
  const summary: LabelBootstrapSummary = {
    reposProcessed: targetRepositories.length,
    reposFailed: 0,
    labelsCreated: 0,
    labelsRenamed: 0,
    labelsUpdated: 0,
    labelsSkipped: 0,
  };

  for (const repository of targetRepositories) {
    const { owner, repo, fullName } = getRepoContext(repository);
    try {
      const result = await labelService.ensureRequiredLabels(owner, repo);
      summary.labelsCreated += result.created;
      summary.labelsRenamed += result.renamed;
      summary.labelsUpdated += result.updated;
      summary.labelsSkipped += result.skipped;
      context.log.info(
        `[${eventName}] Ensured labels in ${fullName}: created=${result.created}, renamed=${result.renamed}, updated=${result.updated}, skipped=${result.skipped}`
      );
    } catch (error) {
      summary.reposFailed += 1;
      context.log.error({ err: error, repo: fullName }, `[${eventName}] Failed to ensure required labels`);
      errors.push(error as Error);
    }
  }

  context.log.info(
    `[${eventName}] Label bootstrap summary: reposProcessed=${summary.reposProcessed}, reposFailed=${summary.reposFailed}, labelsCreated=${summary.labelsCreated}, labelsRenamed=${summary.labelsRenamed}, labelsUpdated=${summary.labelsUpdated}, labelsSkipped=${summary.labelsSkipped}`
  );

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} repository label bootstrap operation(s) failed`);
  }
}

export function app(probotApp: Probot): void {
  probotApp.log.info("Queen bot initialized");

  /**
   * Bootstrap required labels when the app is first installed.
   */
  probotApp.on("installation.created", async (context) => {
    await ensureLabelsForRepositories(
      context,
      context.payload.repositories,
      "installation.created"
    );
  });

  /**
   * Bootstrap required labels for repositories added to an existing installation.
   */
  probotApp.on("installation_repositories.added", async (context) => {
    await ensureLabelsForRepositories(
      context,
      context.payload.repositories_added,
      "installation_repositories.added"
    );
  });

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
      const installationId = context.payload.installation?.id;

      await governance.startDiscussion(
        { owner, repo, issueNumber: number, installationId },
        issueWelcomeMessage
      );
    } catch (error) {
      context.log.error({ err: error, issue: number, repo: fullName }, "Failed to process issue");
      throw error;
    }
  });

  probotApp.on("pull_request.opened", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR #${number} in ${fullName}`);

    // Skip governance processing for PRs targeting non-default branches (stacked PRs)
    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
      context.log.info(
        { owner, repo, pr: number, base: context.payload.pull_request.base.ref },
        "Skipping PR intake — targets non-default branch"
      );
      return;
    }

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [initialLinkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);
      let linkedIssues = initialLinkedIssues;
      const hasBodyClosingKeyword = linkedIssues.length === 0
        ? hasSameRepoClosingKeywordRef(context.payload.pull_request.body, { owner, repo })
        : false;
      let didRetry = false;

      if (linkedIssues.length === 0 && hasBodyClosingKeyword) {
        context.log.info(
          {
            owner,
            repo,
            pr: number,
            retryDelayMs: PR_OPENED_LINK_RETRY_DELAY_MS,
          },
          "PR opened with closing keywords but no linked issues; retrying lookup"
        );
        await delay(PR_OPENED_LINK_RETRY_DELAY_MS);
        linkedIssues = await getLinkedIssues(context.octokit, owner, repo, number);
        didRetry = true;
      }

      // Unlinked PRs get a warning; linked PRs are handled by processImplementationIntake
      if (linkedIssues.length === 0) {
        if (hasBodyClosingKeyword) {
          context.log.warn(
            { owner, repo, pr: number, resolutionSource: "heuristic-suppressed" },
            "PR opened with closing keywords but linked issues remained empty after retry; suppressing warning"
          );
        } else {
          await issues.comment({ owner, repo, issueNumber: number }, MESSAGES.PR_NO_LINKED_ISSUE);
          context.log.info(
            { owner, repo, pr: number, resolutionSource: "none" },
            "PR opened with no linked issues and no closing keywords; posted warning"
          );
        }
      } else {
        const resolutionSource = didRetry ? "retry" : "initial";
        context.log.info(
          { owner, repo, pr: number, linkedIssueCount: linkedIssues.length, resolutionSource },
          "Resolved linked issues for opened PR"
        );
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

    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
      context.log.info(
        { owner, repo, pr: number, base: context.payload.pull_request.base.ref },
        "Skipping PR update intake — targets non-default branch"
      );
      return;
    }

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

    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
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
   * Handle comments on issues and PRs.
   *
   * Routes to either:
   * 1. Command handler — @mention + /command on issues or PRs
   * 2. PR intake processing — non-command comments on PRs
   */
  probotApp.on("issue_comment.created", async (context) => {
    const { issue, comment } = context.payload;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();

      // Skip bot's own comments
      if (comment.performed_via_github_app?.id === appId) {
        return;
      }

      // Parse for @mention + /command before the PR-only filter,
      // so commands work on both issues and PRs
      const parsed = parseCommand(comment.body ?? "");
      if (parsed) {
        await executeCommand({
          octokit: context.octokit as Parameters<typeof executeCommand>[0]["octokit"],
          owner,
          repo,
          issueNumber: issue.number,
          installationId: context.payload.installation?.id,
          commentId: comment.id,
          senderLogin: comment.user.login,
          verb: parsed.verb,
          freeText: parsed.freeText,
          issueLabels: issue.labels?.map((l) =>
            typeof l === "string" ? { name: l } : { name: l.name ?? "" },
          ) ?? [],
          isPullRequest: !!issue.pull_request,
          appId,
          log: context.log,
        });
        return;
      }

      // Non-command comments: only process PR comments for intake
      if (!issue.pull_request) {
        return;
      }

      const prNumber = issue.number;
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
      context.log.error({ err: error, issue: issue.number, repo: fullName }, "Failed to process comment");
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
    if (!isLabelMatch(context.payload.label?.name, LABELS.IMPLEMENTATION)) return;

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

  /**
   * Handle manual phase:voting label additions.
   *
   * When a human adds the `phase:voting` label manually (bypassing the automatic
   * discussion→voting transition), the voting comment is missing. This handler
   * detects that scenario and posts the voting comment idempotently.
   *
   * Skips Bot senders — the automatic transition in `transitionToVoting()` already
   * handles the comment when the app adds the label.
   */
  probotApp.on("issues.labeled", async (context) => {
    const { label, issue, sender } = context.payload;
    if (!isLabelMatch(label?.name, LABELS.VOTING)) return;
    if (sender.type === "Bot") return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(
      `Manual voting label on issue #${issue.number} in ${fullName} (by ${sender.login})`,
    );

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const governance = createGovernanceService(issues);
      const installationId = context.payload.installation?.id;
      const result = await governance.postVotingComment({
        owner, repo, issueNumber: issue.number, installationId,
      });
      context.log.info(`Voting comment for issue #${issue.number}: ${result}`);
    } catch (error) {
      context.log.error(
        { err: error, issue: issue.number, repo: fullName },
        "Failed to post voting comment for manually labeled issue",
      );
      throw error;
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        checks: {
          githubApp: { ready: validation.valid },
          llm: getLLMReadiness(),
        },
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
