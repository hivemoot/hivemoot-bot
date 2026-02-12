/**
 * Repository Label Bootstrap
 *
 * Ensures required labels exist on repositories where the app is installed.
 */

import { REQUIRED_REPOSITORY_LABELS, type RepositoryLabelDefinition } from "../config.js";
import { hasPaginateIterator, validateClient } from "./client-validation.js";

interface ExistingLabel {
  name: string;
}

export interface RepositoryLabelClient {
  rest: {
    issues: {
      listLabelsForRepo: (params: {
        owner: string;
        repo: string;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: ExistingLabel[];
      }>;
      createLabel: (params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
        description?: string;
      }) => Promise<unknown>;
    };
  };
  paginate: {
    iterator: <T>(
      method: unknown,
      params: unknown
    ) => AsyncIterable<{ data: T[] }>;
  };
}

function isValidRepositoryLabelClient(obj: unknown): obj is RepositoryLabelClient {
  return validateClient(obj, [
    {
      path: "rest.issues",
      requiredMethods: ["listLabelsForRepo", "createLabel"],
    },
  ]) && hasPaginateIterator(obj);
}

export interface EnsureLabelsResult {
  created: number;
  skipped: number;
}

export function createRepositoryLabelService(octokit: unknown): RepositoryLabelService {
  if (!isValidRepositoryLabelClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with issues.listLabelsForRepo, issues.createLabel, and paginate.iterator"
    );
  }
  return new RepositoryLabelService(octokit);
}

export class RepositoryLabelService {
  constructor(
    private client: RepositoryLabelClient
  ) {}

  /**
   * Create missing required labels for a repository.
   * Existing labels are preserved as-is.
   */
  async ensureRequiredLabels(
    owner: string,
    repo: string,
    requiredLabels: readonly RepositoryLabelDefinition[] = REQUIRED_REPOSITORY_LABELS
  ): Promise<EnsureLabelsResult> {
    const existingLabels = await this.getExistingLabelNames(owner, repo);
    let created = 0;
    let skipped = 0;

    for (const label of requiredLabels) {
      const key = label.name.toLowerCase();
      if (existingLabels.has(key)) {
        skipped++;
        continue;
      }

      try {
        await this.client.rest.issues.createLabel({
          owner,
          repo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
        existingLabels.add(key);
        created++;
      } catch (error) {
        // Label may have been created concurrently by another process
        if ((error as { status?: number }).status === 422) {
          existingLabels.add(key);
          skipped++;
          continue;
        }
        throw error;
      }
    }

    return { created, skipped };
  }

  private async getExistingLabelNames(owner: string, repo: string): Promise<Set<string>> {
    const iterator = this.client.paginate.iterator<ExistingLabel>(
      this.client.rest.issues.listLabelsForRepo,
      {
        owner,
        repo,
        per_page: 100,
      }
    );

    const existingLabels = new Set<string>();
    for await (const { data } of iterator) {
      for (const label of data) {
        existingLabels.add(label.name.toLowerCase());
      }
    }
    return existingLabels;
  }
}
