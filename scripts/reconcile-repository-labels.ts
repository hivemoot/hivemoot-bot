/**
 * Scheduled Repository Label Reconciliation
 *
 * Sweeps all installed repositories and ensures required labels exist
 * with canonical names, colors, and descriptions.
 *
 * Covers drift that install-time bootstrap cannot:
 * - New required labels introduced after app installation
 * - Label color/description drift from manual edits
 * - Legacy label names that need canonical rename
 */

import { Octokit } from "octokit";
import {
  createRepositoryLabelService,
  logger,
} from "../api/lib/index.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { EnsureLabelsResult, Repository } from "../api/lib/index.js";

/**
 * Process a single repository by reconciling required labels.
 * Exported for testing.
 */
export async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  _appId: number
): Promise<EnsureLabelsResult> {
  const owner = repo.owner.login;
  const repoName = repo.name;

  logger.group(`Processing ${repo.full_name}`);
  try {
    const labelService = createRepositoryLabelService(octokit);
    const result = await labelService.ensureRequiredLabels(owner, repoName);
    logger.info(
      `[${repo.full_name}] Label reconciliation complete: created=${result.created}, renamed=${result.renamed}, updated=${result.updated}, skipped=${result.skipped}`
    );
    return result;
  } finally {
    logger.groupEnd();
  }
}

/**
 * Main entry point — processes all installations and their repositories.
 */
async function main(): Promise<void> {
  await runForAllRepositories({
    scriptName: "scheduled repository-label reconciliation",
    processRepository,
    afterAll: ({ results, failedRepos }) => {
      const totals = results.reduce(
        (acc, { result }) => ({
          created: acc.created + result.created,
          renamed: acc.renamed + result.renamed,
          updated: acc.updated + result.updated,
          skipped: acc.skipped + result.skipped,
        }),
        { created: 0, renamed: 0, updated: 0, skipped: 0 }
      );

      logger.info(
        `Repository-label reconciliation summary: reposProcessed=${results.length}, reposFailed=${failedRepos.length}, created=${totals.created}, renamed=${totals.renamed}, updated=${totals.updated}, skipped=${totals.skipped}`
      );
    },
  });
}

runIfMain(import.meta.url, main);
