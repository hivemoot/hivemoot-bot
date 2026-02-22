/**
 * Repository Label Bootstrap
 *
 * Ensures required labels exist on repositories where the app is installed.
 * During the namespace migration, renames legacy labels (e.g., "phase:voting"
 * → "hivemoot:voting") to preserve existing issue associations.
 */

import { REQUIRED_REPOSITORY_LABELS, LEGACY_LABEL_MAP, type RepositoryLabelDefinition } from "../config.js";
import { hasPaginateIterator, validateClient } from "./client-validation.js";

interface ExistingLabel {
  name: string;
  color: string;
  description: string | null;
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
      updateLabel: (params: {
        owner: string;
        repo: string;
        name: string;
        new_name?: string;
        color?: string;
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
      requiredMethods: ["listLabelsForRepo", "createLabel", "updateLabel"],
    },
  ]) && hasPaginateIterator(obj);
}

export interface EnsureLabelsResult {
  created: number;
  renamed: number;
  updated: number;
  skipped: number;
  renamedLabels: Array<{ from: string; to: string }>;
}

export interface AuditLabelsResult {
  missing: number;
  legacyAliases: number;
  metadataDrift: number;
  alreadyCorrect: number;
  renameableLabels: Array<{ from: string; to: string }>;
}

export function createRepositoryLabelService(octokit: unknown): RepositoryLabelService {
  if (!isValidRepositoryLabelClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with issues.listLabelsForRepo, issues.createLabel, issues.updateLabel, and paginate.iterator"
    );
  }
  return new RepositoryLabelService(octokit);
}

/**
 * Build reverse lookup: canonical label name → legacy names that map to it.
 */
function buildReverseLegacyMap(): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [legacy, canonical] of Object.entries(LEGACY_LABEL_MAP)) {
    const existing = reverse.get(canonical) ?? [];
    existing.push(legacy);
    reverse.set(canonical, existing);
  }
  return reverse;
}

/**
 * Check if an existing label's color or description differs from the required definition.
 * Color comparison strips leading '#' and is case-insensitive (GitHub normalises to lowercase hex).
 */
function needsUpdate(existing: ExistingLabel, required: RepositoryLabelDefinition): boolean {
  const existingColor = existing.color.replace(/^#/, "").toLowerCase();
  const requiredColor = required.color.replace(/^#/, "").toLowerCase();
  if (existingColor !== requiredColor) return true;
  if ((existing.description ?? "") !== (required.description ?? "")) return true;
  return false;
}

export class RepositoryLabelService {
  constructor(
    private client: RepositoryLabelClient
  ) {}

  /**
   * Audit required labels without applying changes.
   *
   * Uses the same reconciliation logic as ensureRequiredLabels, but performs
   * a dry run that reports what would be created/renamed/updated.
   */
  async auditRequiredLabels(
    owner: string,
    repo: string,
    requiredLabels: readonly RepositoryLabelDefinition[] = REQUIRED_REPOSITORY_LABELS
  ): Promise<AuditLabelsResult> {
    const result = await this.reconcileRequiredLabels(owner, repo, requiredLabels, false);
    return {
      missing: result.created,
      legacyAliases: result.renamed,
      metadataDrift: result.updated,
      alreadyCorrect: result.skipped,
      renameableLabels: result.renamedLabels,
    };
  }

  /**
   * Ensure required labels exist in a repository.
   *
   * For each required label not already present under its canonical name:
   * 1. Check if a legacy equivalent exists → rename it (preserves issue associations)
   * 2. Otherwise → create the label fresh
   */
  async ensureRequiredLabels(
    owner: string,
    repo: string,
    requiredLabels: readonly RepositoryLabelDefinition[] = REQUIRED_REPOSITORY_LABELS
  ): Promise<EnsureLabelsResult> {
    return this.reconcileRequiredLabels(owner, repo, requiredLabels, true);
  }

  private async reconcileRequiredLabels(
    owner: string,
    repo: string,
    requiredLabels: readonly RepositoryLabelDefinition[],
    applyChanges: boolean
  ): Promise<EnsureLabelsResult> {
    const existingLabels = await this.getExistingLabels(owner, repo);
    const reverseLegacy = buildReverseLegacyMap();
    let created = 0;
    let renamed = 0;
    let updated = 0;
    let skipped = 0;
    const renamedLabels: Array<{ from: string; to: string }> = [];

    for (const label of requiredLabels) {
      const key = label.name.toLowerCase();
      const existing = existingLabels.get(key);
      if (existing) {
        // Label exists — check if color or description need repair
        if (needsUpdate(existing, label)) {
          if (applyChanges) {
            await this.client.rest.issues.updateLabel({
              owner,
              repo,
              name: existing.name,
              color: label.color,
              description: label.description,
            });
          }
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      // Check for a legacy label that can be renamed
      const legacyNames = reverseLegacy.get(label.name) ?? [];
      const foundLegacy = legacyNames.find((name) => existingLabels.has(name.toLowerCase()));

      if (foundLegacy) {
        if (applyChanges) {
          try {
            await this.client.rest.issues.updateLabel({
              owner,
              repo,
              name: foundLegacy,
              new_name: label.name,
              color: label.color,
              description: label.description,
            });
            existingLabels.delete(foundLegacy.toLowerCase());
            existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
            renamed++;
            renamedLabels.push({ from: foundLegacy, to: label.name });
            continue;
          } catch (error) {
            // If rename fails (e.g., concurrent rename), fall through to create
            if ((error as { status?: number }).status === 422) {
              existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
              skipped++;
              continue;
            }
            throw error;
          }
        }

        existingLabels.delete(foundLegacy.toLowerCase());
        existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
        renamed++;
        renamedLabels.push({ from: foundLegacy, to: label.name });
        continue;
      }

      if (applyChanges) {
        try {
          await this.client.rest.issues.createLabel({
            owner,
            repo,
            name: label.name,
            color: label.color,
            description: label.description,
          });
          existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
          created++;
          continue;
        } catch (error) {
          // Label may have been created concurrently by another process
          if ((error as { status?: number }).status === 422) {
            existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
            skipped++;
            continue;
          }
          throw error;
        }
      }

      existingLabels.set(key, { name: label.name, color: label.color, description: label.description ?? null });
      created++;
    }

    return { created, renamed, updated, skipped, renamedLabels };
  }

  private async getExistingLabels(owner: string, repo: string): Promise<Map<string, ExistingLabel>> {
    const iterator = this.client.paginate.iterator<ExistingLabel>(
      this.client.rest.issues.listLabelsForRepo,
      {
        owner,
        repo,
        per_page: 100,
      }
    );

    const existingLabels = new Map<string, ExistingLabel>();
    for await (const { data } of iterator) {
      for (const label of data) {
        existingLabels.set(label.name.toLowerCase(), label);
      }
    }
    return existingLabels;
  }
}
