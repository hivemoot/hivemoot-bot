/**
 * Onboarding Service
 *
 * Auto-creates a "Configure Hivemoot" PR in each repo when the app is installed.
 * Follows the Renovate pattern: immediate visible value on install with a
 * natural place to customize config before activating governance.
 *
 * Three-layer idempotency ensures safe webhook redelivery:
 * 1. Check if .github/hivemoot.yml already exists → skip
 * 2. Check if a configure PR already exists (open or closed) → skip
 * 3. Handle branch creation 422 (race condition) → continue to PR
 */

import { SIGNATURE } from "../config.js";
import {
  validateClient,
  ONBOARDING_CLIENT_CHECKS,
} from "./client-validation.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface OnboardingClient {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: {
          archived: boolean;
          disabled: boolean;
          default_branch: string;
        };
      }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<{ data: unknown }>;
      createOrUpdateFileContents: (params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch: string;
      }) => Promise<unknown>;
      getBranch: (params: {
        owner: string;
        repo: string;
        branch: string;
      }) => Promise<{
        data: { commit: { sha: string } };
      }>;
    };
    git: {
      createRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }) => Promise<unknown>;
    };
    pulls: {
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
      list: (params: {
        owner: string;
        repo: string;
        head: string;
        state: "open" | "closed" | "all";
      }) => Promise<{
        data: Array<{ number: number; state: string }>;
      }>;
    };
  };
}

export type OnboardingResult =
  | { status: "created"; prNumber: number; prUrl: string }
  | {
      status: "skipped";
      reason:
        | "config-exists"
        | "archived"
        | "pr-exists"
        | "pr-previously-closed"
        | "empty-repo";
    };

export interface OnboardingService {
  createOnboardingPR: (
    owner: string,
    repo: string,
  ) => Promise<OnboardingResult>;
}

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = ".github/hivemoot.yml";
const BRANCH_NAME = "hivemoot/configure";
const PR_TITLE = "Configure Hivemoot";
const COMMIT_MESSAGE = "Add default Hivemoot configuration";

// ───────────────────────────────────────────────────────────────────────────────
// Default Config YAML
// ───────────────────────────────────────────────────────────────────────────────

/**
 * All-manual default config matching getDefaultConfig() from repo-config.ts.
 * Comments explain each option with commented-out auto examples.
 */
export const DEFAULT_CONFIG_YAML = `# Hivemoot Configuration
# Docs: https://github.com/hivemoot/hivemoot
version: 1

# ── Team ────────────────────────────────────────────────────────────
# Roles define agent personas — who they are, not what they do.
# Customize the roles below or add your own.

team:
  # onboarding: |
  #   Read CONTRIBUTING.md before starting work.

  roles:
    pm:
      description: "Product manager focused on user value and clarity"
      instructions: |
        You think from the user's perspective.
        Evaluate ideas by the problem they solve and who benefits.
        Push for clear requirements and well-scoped proposals.

    engineer:
      description: "Software engineer focused on clean implementation"
      instructions: |
        You care about code quality, patterns, and maintainability.
        Favor simple, proven approaches over clever solutions.
        Write clean code with good test coverage.

    reviewer:
      description: "Code reviewer focused on correctness and edge cases"
      instructions: |
        You think about what can go wrong.
        Find edge cases, race conditions, and failure modes others miss.
        Push for thorough error handling and defensive design.

# ── Governance ──────────────────────────────────────────────────────

governance:
  proposals:
    # Discussion phase — how issues progress toward consensus
    discussion:
      exits:
        - type: manual
        # Uncomment for automatic progression after 24 hours:
        # - type: auto
        #   afterMinutes: 1440

    # Consensus phase — how the group reaches agreement
    voting:
      exits:
        - type: manual
        # Uncomment for automatic resolution after 24 hours:
        # - type: auto
        #   afterMinutes: 1440
        #   requires: majority   # "majority" or "unanimous"
        #   minVoters: 3

    # Extended consensus — second round for ties/inconclusive results
    extendedVoting:
      exits:
        - type: manual
        # Uncomment for automatic resolution:
        # - type: auto
        #   afterMinutes: 1440
        #   requires: majority
        #   minVoters: 3

  # pr:
  #   staleDays: 3            # Days of inactivity before a PR is marked stale
  #   maxPRsPerIssue: 3       # Max competing implementations per issue
  #   trustedReviewers: []    # GitHub usernames whose approvals count for intake/merge-ready
  #   intake:
  #     - method: auto        # Pre-ready PRs activate immediately when issue becomes ready (default)
  #   mergeReady:             # Omit to disable merge-ready automation
  #     minApprovals: 1
`;

// ───────────────────────────────────────────────────────────────────────────────
// PR Body
// ───────────────────────────────────────────────────────────────────────────────

const PR_BODY = `## Welcome to Hivemoot! 🐝

This PR adds a default \`.github/hivemoot.yml\` configuration file to your repository.

### What happens when you merge

Merging this PR adds a starting configuration for your repository. Review and customize the settings before merging — the config is a starting point, not a final state.

### What's in the config

**Team roles** — Three starter roles (pm, engineer, reviewer) that define agent personas. Add, remove, or customize roles to match your team.

**Governance phases** — Controls how issues flow through the governance pipeline:

\`\`\`
Issue opened → 🗣️ Discussion → 🤝 Consensus → ✅ Ready to implement → 🔨 PRs compete → 🎉 Merged
\`\`\`

All phases default to \`manual\` progression. Uncomment the \`auto\` exits to enable time-based automation.

**PR settings** — Commented out by default. Uncomment to enable stale PR warnings, competing PR limits, trusted reviewers, and merge-readiness checks.

### Useful commands

Comment on any issue or PR to use these (maintainer-only):

| Command | Where | What it does |
|---------|-------|-------------|
| \`@hivemoot /vote\` | Issue | Move from discussion → consensus phase |
| \`@hivemoot /implement\` | Issue | Fast-track to ready-to-implement |
| \`@hivemoot /gather\` | Issue | Summarize discussion into a blueprint |
| \`@hivemoot /preflight\` | PR | Run merge-readiness checks |
| \`@hivemoot /squash\` | PR | Preflight + squash merge |
| \`@hivemoot /doctor\` | Any | Health check for this repo's setup |

### Running agents

Hivemoot doesn't offer hosted agents yet. Once you've configured your team roles above, you run your own agents using the [hivemoot-agent](https://github.com/hivemoot/hivemoot-agent) Docker container on any infrastructure you choose (cloud VM, CI runner, local machine).

Each agent assumes a role from your config and participates in governance — discussing issues, reviewing PRs, and building consensus.

### Next steps

1. **Edit the roles** — customize for your project's needs
2. **Review governance settings** — enable automation if desired
3. **Merge** — Hivemoot starts managing governance on new issues
4. **Run agents** — deploy [hivemoot-agent](https://github.com/hivemoot/hivemoot-agent) containers with your roles

📖 [Documentation](https://github.com/hivemoot/hivemoot) · 💬 [Questions & Discussion](https://github.com/hivemoot/hivemoot/discussions)

${SIGNATURE}`;

// ───────────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────────

function isValidOnboardingClient(obj: unknown): obj is OnboardingClient {
  return validateClient(obj, ONBOARDING_CLIENT_CHECKS);
}

export function createOnboardingService(octokit: unknown): OnboardingService {
  if (!isValidOnboardingClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with repos.get, repos.getContent, " +
        "repos.createOrUpdateFileContents, repos.getBranch, git.createRef, pulls.create, and pulls.list",
    );
  }

  return {
    createOnboardingPR: (owner: string, repo: string) =>
      createOnboardingPR(octokit, owner, repo),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────────────

async function createOnboardingPR(
  client: OnboardingClient,
  owner: string,
  repo: string,
): Promise<OnboardingResult> {
  const fullName = `${owner}/${repo}`;

  // 1. Check if repo is archived or disabled
  const { data: repoData } = await client.rest.repos.get({ owner, repo });
  if (repoData.archived || repoData.disabled) {
    logger.info(`[onboarding] Skipping ${fullName}: archived or disabled`);
    return { status: "skipped", reason: "archived" };
  }

  // 2. Check if config already exists
  try {
    await client.rest.repos.getContent({ owner, repo, path: CONFIG_PATH });
    logger.info(`[onboarding] Skipping ${fullName}: config already exists`);
    return { status: "skipped", reason: "config-exists" };
  } catch (error) {
    if ((error as { status?: number }).status !== 404) {
      throw error;
    }
    // 404 means no config file — proceed
  }

  // 3. Check if a configure PR already exists (any state)
  const headRef = `${owner}:${BRANCH_NAME}`;
  const { data: existingPRs } = await client.rest.pulls.list({
    owner,
    repo,
    head: headRef,
    state: "all",
  });

  if (existingPRs.length > 0) {
    const hasOpen = existingPRs.some((pr) => pr.state === "open");
    const reason = hasOpen ? "pr-exists" : "pr-previously-closed";
    logger.info(`[onboarding] Skipping ${fullName}: ${reason}`);
    return { status: "skipped", reason };
  }

  // 4. Get default branch tip SHA (also detects empty repos)
  const defaultBranch = repoData.default_branch;
  let baseSha: string;
  try {
    const { data: branchData } = await client.rest.repos.getBranch({
      owner,
      repo,
      branch: defaultBranch,
    });
    baseSha = branchData.commit.sha;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      logger.info(
        `[onboarding] Skipping ${fullName}: empty repo (no default branch)`,
      );
      return { status: "skipped", reason: "empty-repo" };
    }
    throw error;
  }

  // 5. Create the onboarding branch — catch 422 (branch exists from a race)
  try {
    await client.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${BRANCH_NAME}`,
      sha: baseSha,
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 422) {
      throw error;
    }
    // 422 means branch already exists (concurrent webhook delivery) — continue
    logger.info(
      `[onboarding] Branch ${BRANCH_NAME} already exists in ${fullName} (race condition)`,
    );
  }

  // 6. Commit the default config file
  const contentBase64 = Buffer.from(DEFAULT_CONFIG_YAML, "utf-8").toString(
    "base64",
  );
  await client.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: CONFIG_PATH,
    message: COMMIT_MESSAGE,
    content: contentBase64,
    branch: BRANCH_NAME,
  });

  // 7. Open the PR
  const { data: pr } = await client.rest.pulls.create({
    owner,
    repo,
    title: PR_TITLE,
    body: PR_BODY,
    head: BRANCH_NAME,
    base: defaultBranch,
  });

  logger.info(
    `[onboarding] Created onboarding PR #${pr.number} in ${fullName}`,
  );
  return { status: "created", prNumber: pr.number, prUrl: pr.html_url };
}
