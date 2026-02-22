/**
 * Onboarding PR Service
 *
 * Auto-creates a "Configure Hivemoot" PR when the app is installed on a
 * repository. Follows the Renovate pattern for immediate visible feedback.
 *
 * Three-layer idempotency:
 *   1. Config file already exists → skip
 *   2. Open onboarding PR already exists → skip
 *   3. Branch already exists (422) → continue to PR creation
 */

import { validateClient } from "./client-validation.js";

export const ONBOARDING_BRANCH = "hivemoot/configure";
const ONBOARDING_CONFIG_PATH = ".github/hivemoot.yml";
const ONBOARDING_COMMIT_MESSAGE = "Add Hivemoot configuration";

const ONBOARDING_CONFIG_CONTENT = `# Hivemoot configuration
# See https://github.com/hivemoot/hivemoot-bot#configuration for all options.
#
# Merging this PR activates Hivemoot governance on this repository.
# Close without merging to opt out — the bot will not automatically re-create this PR.

version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 1440  # 24 hours
    voting:
      exits:
        - type: auto
          afterMinutes: 1440  # 24 hours
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 1440  # 24 hours
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
    intake:
      - method: update  # require PR activity after issue approval (method: auto coming soon — see #326)
    # trustedReviewers:
    #   - your-github-username
    # mergeReady:
    #   minApprovals: 2

# standup:
#   enabled: true
#   category: "Hivemoot Reports"
`;

const ONBOARDING_PR_TITLE = "Configure Hivemoot";
const ONBOARDING_PR_BODY = `Welcome to Hivemoot! 🐝

This PR adds a default \`.github/hivemoot.yml\` configuration file.

## What merging this PR does

- Issues automatically enter the governance lifecycle: discussion → voting → implementation
- PRs linked to approved issues are tracked for implementation competition
- Stale PR warnings run on a schedule

## What closing this PR (without merging) does

Nothing. Hivemoot stays installed but runs no automations until a config file exists.

## Customize before merging

Edit \`.github/hivemoot.yml\` in this PR to adjust timing, PR limits, or trusted reviewers. See the [configuration reference](https://github.com/hivemoot/hivemoot-bot#configuration) for all options.`;

// ─────────────────────────────────────────────────────────────────────────────
// Client interface
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingClient {
  rest: {
    repos: {
      get: (params: {
        owner: string;
        repo: string;
      }) => Promise<{
        data: {
          default_branch: string;
          archived: boolean;
        };
      }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<unknown>;
      createOrUpdateFileContents: (params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch: string;
      }) => Promise<unknown>;
    };
    git: {
      getRef: (params: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{
        data: {
          object: { sha: string };
        };
      }>;
      createRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }) => Promise<unknown>;
    };
    pulls: {
      list: (params: {
        owner: string;
        repo: string;
        state: string;
        head: string;
        per_page?: number;
      }) => Promise<{
        data: Array<{ number: number; html_url: string }>;
      }>;
      create: (params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
      }) => Promise<{
        data: { number: number; html_url: string };
      }>;
    };
  };
}

function isValidOnboardingClient(obj: unknown): obj is OnboardingClient {
  return validateClient(obj, [
    {
      path: "rest.repos",
      requiredMethods: ["get", "getContent", "createOrUpdateFileContents"],
    },
    {
      path: "rest.git",
      requiredMethods: ["getRef", "createRef"],
    },
    {
      path: "rest.pulls",
      requiredMethods: ["list", "create"],
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingResult {
  skipped: boolean;
  reason?: string;
  prNumber?: number;
  prUrl?: string;
}

export class OnboardingService {
  constructor(private client: OnboardingClient) {}

  async createOnboardingPR(owner: string, repo: string): Promise<OnboardingResult> {
    // Layer 1: skip archived repos
    const { data: repoData } = await this.client.rest.repos.get({ owner, repo });
    if (repoData.archived) {
      return { skipped: true, reason: "archived" };
    }

    const defaultBranch = repoData.default_branch;

    // Layer 2: skip if config file already exists
    const configExists = await this.checkConfigExists(owner, repo);
    if (configExists) {
      return { skipped: true, reason: "config-exists" };
    }

    // Layer 3: skip if an open onboarding PR already exists
    const existingPR = await this.findOpenOnboardingPR(owner, repo, owner);
    if (existingPR) {
      return { skipped: true, reason: "pr-exists", prNumber: existingPR.number, prUrl: existingPR.html_url };
    }

    // Get the HEAD SHA of the default branch
    let headSha: string;
    try {
      const { data: refData } = await this.client.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });
      headSha = refData.object.sha;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        // Empty repo — nothing to branch from
        return { skipped: true, reason: "empty-repo" };
      }
      throw error;
    }

    // Create the onboarding branch (422 = already exists, continue)
    try {
      await this.client.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${ONBOARDING_BRANCH}`,
        sha: headSha,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 422) {
        throw error;
      }
      // Branch already exists — fall through to file + PR creation
    }

    // Create the config file on the onboarding branch
    const content = Buffer.from(ONBOARDING_CONFIG_CONTENT).toString("base64");
    try {
      await this.client.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: ONBOARDING_CONFIG_PATH,
        message: ONBOARDING_COMMIT_MESSAGE,
        content,
        branch: ONBOARDING_BRANCH,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 422) {
        throw error;
      }
      // File already exists on branch — continue to PR creation
    }

    // Create the PR
    const { data: pr } = await this.client.rest.pulls.create({
      owner,
      repo,
      title: ONBOARDING_PR_TITLE,
      body: ONBOARDING_PR_BODY,
      head: ONBOARDING_BRANCH,
      base: defaultBranch,
    });

    return { skipped: false, prNumber: pr.number, prUrl: pr.html_url };
  }

  private async checkConfigExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.client.rest.repos.getContent({ owner, repo, path: ONBOARDING_CONFIG_PATH });
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        return false;
      }
      throw error;
    }
  }

  private async findOpenOnboardingPR(
    owner: string,
    repo: string,
    repoOwner: string
  ): Promise<{ number: number; html_url: string } | null> {
    // GitHub head filter format: "owner:branch"
    const { data: prs } = await this.client.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${repoOwner}:${ONBOARDING_BRANCH}`,
      per_page: 1,
    });
    return prs[0] ?? null;
  }
}

export function createOnboardingService(octokit: unknown): OnboardingService {
  if (!isValidOnboardingClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with rest.repos.get, rest.repos.getContent, rest.repos.createOrUpdateFileContents, rest.git.getRef, rest.git.createRef, rest.pulls.list, and rest.pulls.create"
    );
  }
  return new OnboardingService(octokit);
}
