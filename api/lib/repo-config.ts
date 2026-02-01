/**
 * Per-Repository Configuration Loader
 *
 * Loads governance configuration from .github/hivemoot.yml in customer repositories.
 * Provides per-repo customization while maintaining safe boundaries.
 *
 * Config hierarchy (lowest to highest priority):
 * 1. Global defaults (env-derived, clamped to CONFIG_BOUNDS)
 * 2. Per-repo .github/hivemoot.yml
 */

import * as yaml from "js-yaml";
import {
  CONFIG_BOUNDS,
  DISCUSSION_DURATION_MS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
  VOTING_DURATION_MS,
} from "../config.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Schema for .github/hivemoot.yml config file
 */
export interface RepoConfigFile {
  governance?: {
    discussionDurationMinutes?: number;
    votingDurationMinutes?: number;
  };
  pr?: {
    staleDays?: number;
    maxPRsPerIssue?: number;
  };
}

/**
 * Effective configuration after merging repo config with defaults.
 * All values are guaranteed to be within safe boundaries.
 */
export interface EffectiveConfig {
  governance: {
    discussionDurationMs: number;
    votingDurationMs: number;
  };
  pr: {
    staleDays: number;
    maxPRsPerIssue: number;
  };
}

/**
 * Minimal GitHub client interface for fetching repo content.
 * Compatible with both Octokit and Probot's context.octokit.
 *
 * The getContent API returns different shapes depending on the path:
 * - Single file: { type: "file", content: "...", ... }
 * - Directory: array of items
 * - Symlink/submodule: different structures
 *
 * We use `unknown` for the response data and handle the shape at runtime.
 */
export interface RepoConfigClient {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<{
        data: unknown;
      }>;
    };
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Config Loading
// ───────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = ".github/hivemoot.yml";
const MS_PER_MINUTE = 60 * 1000;
const DEFAULT_DISCUSSION_MINUTES = Math.round(DISCUSSION_DURATION_MS / MS_PER_MINUTE);
const DEFAULT_VOTING_MINUTES = Math.round(VOTING_DURATION_MS / MS_PER_MINUTE);

const DISCUSSION_DURATION_BOUNDS = {
  ...CONFIG_BOUNDS.phaseDurationMinutes,
  default: DEFAULT_DISCUSSION_MINUTES,
};

const VOTING_DURATION_BOUNDS = {
  ...CONFIG_BOUNDS.phaseDurationMinutes,
  default: DEFAULT_VOTING_MINUTES,
};

const PR_STALE_DAYS_BOUNDS = {
  ...CONFIG_BOUNDS.prStaleDays,
  default: PR_STALE_THRESHOLD_DAYS,
};

const MAX_PRS_PER_ISSUE_BOUNDS = {
  ...CONFIG_BOUNDS.maxPRsPerIssue,
  default: MAX_PRS_PER_ISSUE,
};

/**
 * Clamp a value to the specified bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate and clamp a duration value from config.
 * Returns the clamped value in milliseconds, or default if invalid.
 */
function parseDurationMinutes(
  value: unknown,
  bounds: { min: number; max: number; default: number },
  fieldName: string,
  repoFullName: string
): number {
  if (value === undefined || value === null) {
    return bounds.default * 60 * 1000;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    logger.warn(
      `[${repoFullName}] Invalid ${fieldName}: expected number, got ${typeof value}. Using default.`
    );
    return bounds.default * 60 * 1000;
  }

  const clamped = clamp(value, bounds.min, bounds.max);
  if (clamped !== value) {
    logger.info(
      `[${repoFullName}] ${fieldName} clamped from ${value} to ${clamped} (bounds: ${bounds.min}-${bounds.max})`
    );
  }

  return clamped * 60 * 1000;
}

/**
 * Validate and clamp an integer value from config.
 * Returns the clamped value, or default if invalid.
 */
function parseIntValue(
  value: unknown,
  bounds: { min: number; max: number; default: number },
  fieldName: string,
  repoFullName: string
): number {
  if (value === undefined || value === null) {
    return bounds.default;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    logger.warn(
      `[${repoFullName}] Invalid ${fieldName}: expected number, got ${typeof value}. Using default.`
    );
    return bounds.default;
  }

  // Round to integer for non-integer inputs
  const intValue = Math.round(value);
  const clamped = clamp(intValue, bounds.min, bounds.max);

  if (clamped !== value) {
    logger.info(
      `[${repoFullName}] ${fieldName} clamped from ${value} to ${clamped} (bounds: ${bounds.min}-${bounds.max})`
    );
  }

  return clamped;
}

/**
 * Parse and validate a RepoConfigFile object.
 * Returns EffectiveConfig with all values validated and clamped.
 */
function parseRepoConfig(raw: unknown, repoFullName: string): EffectiveConfig {
  const config = raw as RepoConfigFile | undefined;

  return {
    governance: {
      discussionDurationMs: parseDurationMinutes(
        config?.governance?.discussionDurationMinutes,
        DISCUSSION_DURATION_BOUNDS,
        "governance.discussionDurationMinutes",
        repoFullName
      ),
      votingDurationMs: parseDurationMinutes(
        config?.governance?.votingDurationMinutes,
        VOTING_DURATION_BOUNDS,
        "governance.votingDurationMinutes",
        repoFullName
      ),
    },
    pr: {
      staleDays: parseIntValue(
        config?.pr?.staleDays,
        PR_STALE_DAYS_BOUNDS,
        "pr.staleDays",
        repoFullName
      ),
      maxPRsPerIssue: parseIntValue(
        config?.pr?.maxPRsPerIssue,
        MAX_PRS_PER_ISSUE_BOUNDS,
        "pr.maxPRsPerIssue",
        repoFullName
      ),
    },
  };
}

/**
 * Get the default configuration (env-derived, clamped to CONFIG_BOUNDS).
 */
export function getDefaultConfig(): EffectiveConfig {
  return {
    governance: {
      discussionDurationMs: DISCUSSION_DURATION_MS,
      votingDurationMs: VOTING_DURATION_MS,
    },
    pr: {
      staleDays: PR_STALE_THRESHOLD_DAYS,
      maxPRsPerIssue: MAX_PRS_PER_ISSUE,
    },
  };
}

/**
 * Load repository configuration from .github/hivemoot.yml.
 *
 * Fetches the config file from the repository using GitHub Contents API,
 * parses YAML, validates values, and clamps to safe boundaries.
 *
 * @param octokit - GitHub client (Octokit or Probot context.octokit)
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns EffectiveConfig with validated settings
 */
export async function loadRepositoryConfig(
  octokit: RepoConfigClient,
  owner: string,
  repo: string
): Promise<EffectiveConfig> {
  const repoFullName = `${owner}/${repo}`;

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: CONFIG_PATH,
    });

    // Type guard for file response
    const data = response.data as { type?: string; content?: string } | unknown[];

    // Verify we got a file (not a directory - which would be an array)
    if (Array.isArray(data) || typeof data !== "object" || data === null) {
      logger.warn(`[${repoFullName}] ${CONFIG_PATH} is not a file. Using defaults.`);
      return getDefaultConfig();
    }

    if (data.type !== "file" || !data.content) {
      logger.warn(`[${repoFullName}] ${CONFIG_PATH} is not a file. Using defaults.`);
      return getDefaultConfig();
    }

    // Decode base64 content
    const content = Buffer.from(data.content, "base64").toString("utf-8");

    // Parse YAML
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (yamlError) {
      logger.warn(
        `[${repoFullName}] Invalid YAML in ${CONFIG_PATH}: ${(yamlError as Error).message}. Using defaults.`
      );
      return getDefaultConfig();
    }

    // Handle empty file
    if (parsed === undefined || parsed === null) {
      logger.debug(`[${repoFullName}] Empty ${CONFIG_PATH}. Using defaults.`);
      return getDefaultConfig();
    }

    // Handle non-object YAML (e.g., just a string or array)
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn(
        `[${repoFullName}] ${CONFIG_PATH} must be a YAML object. Using defaults.`
      );
      return getDefaultConfig();
    }

    logger.info(`[${repoFullName}] Loaded config from ${CONFIG_PATH}`);
    return parseRepoConfig(parsed, repoFullName);
  } catch (error) {
    const status = (error as { status?: number }).status;

    // 404 is expected when repo doesn't have a config file
    if (status === 404) {
      logger.debug(`[${repoFullName}] No ${CONFIG_PATH} found. Using defaults.`);
      return getDefaultConfig();
    }

    // Policy: config load errors should not block processing; log and use defaults.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusSuffix = status ? ` (status ${status})` : "";
    logger.warn(
      `[${repoFullName}] Failed to load ${CONFIG_PATH}${statusSuffix}: ${errorMessage}. Using defaults.`
    );
    return getDefaultConfig();
  }
}
