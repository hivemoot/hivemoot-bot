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
  VOTING_DURATION_MS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
} from "../config.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export type RequiredVotersMode = "all" | "any";

export interface RequiredVotersConfig {
  mode: RequiredVotersMode;
  voters: string[];
}

export type ExitRequires = "majority" | "unanimous";

export interface VotingExit {
  afterMs: number;
  requires: ExitRequires;
  minVoters: number;
  requiredVoters: RequiredVotersConfig;
}

/**
 * Schema for .github/hivemoot.yml config file.
 */
export interface RepoConfigFile {
  version?: number;
  governance?: {
    proposals?: {
      discussion?: {
        durationMinutes?: number;
      };
      voting?: {
        minVoters?: number;
        requiredVoters?: unknown;
        exits?: unknown[];
      };
    };
    pr?: {
      staleDays?: number;
      maxPRsPerIssue?: number;
    };
  };
}

/**
 * Effective configuration after merging repo config with defaults.
 * All values are guaranteed to be within safe boundaries.
 */
export interface EffectiveConfig {
  version: number;
  governance: {
    proposals: {
      discussion: {
        durationMs: number;
      };
      voting: {
        exits: VotingExit[];
        /** Derived from last exit's afterMs (the deadline) */
        durationMs: number;
      };
    };
    pr: {
      staleDays: number;
      maxPRsPerIssue: number;
    };
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

const DISCUSSION_DURATION_BOUNDS = {
  ...CONFIG_BOUNDS.phaseDurationMinutes,
  default: DEFAULT_DISCUSSION_MINUTES,
};

const PR_STALE_DAYS_BOUNDS = {
  ...CONFIG_BOUNDS.prStaleDays,
  default: PR_STALE_THRESHOLD_DAYS,
};

const MAX_PRS_PER_ISSUE_BOUNDS = {
  ...CONFIG_BOUNDS.maxPRsPerIssue,
  default: MAX_PRS_PER_ISSUE,
};

const MIN_VOTERS_BOUNDS = {
  ...CONFIG_BOUNDS.voting.minVoters,
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
 * Parse and validate a voters array from config.
 * Returns a deduplicated, lowercased array clamped to maxEntries/maxUsernameLength.
 */
function parseVotersList(
  value: unknown,
  repoFullName: string
): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters.voters: expected array. Using default (empty).`
      );
    }
    return [];
  }

  const { maxEntries, maxUsernameLength } = CONFIG_BOUNDS.requiredVoters;

  const result: string[] = [];
  const seen = new Set<string>();
  const isValidGitHubUsername = (name: string): boolean =>
    /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(name);

  for (const entry of value) {
    if (result.length >= maxEntries) {
      logger.info(
        `[${repoFullName}] requiredVoters truncated to ${maxEntries} entries`
      );
      break;
    }

    if (typeof entry !== "string" || entry.length === 0) {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters entry: expected non-empty string, got ${typeof entry}. Skipping.`
      );
      continue;
    }

    // Strip whitespace and optional leading @ (common in GitHub config contexts)
    const cleaned = entry.trim().replace(/^@/, "");
    if (cleaned.length === 0) {
      logger.warn(
        `[${repoFullName}] Empty requiredVoters entry after trimming: "${entry}". Skipping.`
      );
      continue;
    }

    if (cleaned.length > maxUsernameLength) {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters entry '${cleaned}': exceeds max length ${maxUsernameLength}. Skipping.`
      );
      continue;
    }

    const normalized = cleaned.toLowerCase();
    if (!isValidGitHubUsername(normalized)) {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters entry '${cleaned}': not a valid GitHub username. Skipping.`
      );
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Parse and validate requiredVoters from config.
 *
 * Accepts either:
 * - Array shorthand: ["alice", "bob"] → { mode: "all", voters: [...] }
 * - Object format: { mode: "any", voters: ["alice"] }
 */
function parseRequiredVotersConfig(
  value: unknown,
  repoFullName: string
): RequiredVotersConfig {
  if (value === undefined || value === null) {
    return { mode: "all", voters: [] };
  }

  // Array shorthand → mode: "all"
  if (Array.isArray(value)) {
    return { mode: "all", voters: parseVotersList(value, repoFullName) };
  }

  if (typeof value !== "object") {
    logger.warn(
      `[${repoFullName}] Invalid requiredVoters: expected object or array. Using default.`
    );
    return { mode: "all", voters: [] };
  }

  const obj = value as { mode?: unknown; voters?: unknown };

  // Validate mode
  let mode: RequiredVotersMode = "all";
  if (obj.mode !== undefined && obj.mode !== null) {
    if (obj.mode === "all" || obj.mode === "any") {
      mode = obj.mode;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters.mode: "${String(obj.mode)}". Using default ("all").`
      );
    }
  }

  return { mode, voters: parseVotersList(obj.voters, repoFullName) };
}

const VALID_REQUIRES: ExitRequires[] = ["majority", "unanimous"];

/**
 * Parse and validate exits from config.
 *
 * Each exit has:
 * - afterMinutes: time gate (clamped to phaseDurationMinutes bounds)
 * - requires: "majority" (default) or "unanimous"
 * - minVoters: quorum (clamped to voting.minVoters bounds)
 * - requiredVoters: participation requirement
 *
 * Sorted ascending by afterMs. Must have at least one entry.
 *
 * `defaultMinVoters` and `defaultRequiredVoters` are inherited from top-level
 * voting config for exits that don't specify their own.
 */
function parseExits(
  value: unknown,
  repoFullName: string,
  defaultMinVoters: number = CONFIG_BOUNDS.voting.minVoters.default,
  defaultRequiredVoters: RequiredVotersConfig = { mode: "all", voters: [] },
): VotingExit[] {
  const defaultExit: VotingExit = {
    afterMs: VOTING_DURATION_MS,
    requires: "majority",
    minVoters: defaultMinVoters,
    requiredVoters: defaultRequiredVoters,
  };

  if (value === undefined || value === null) {
    return [defaultExit];
  }

  if (!Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid exits: expected array. Using default.`
    );
    return [defaultExit];
  }

  if (value.length === 0) {
    logger.warn(
      `[${repoFullName}] Empty exits array. Using default.`
    );
    return [defaultExit];
  }

  const bounds = CONFIG_BOUNDS.phaseDurationMinutes;

  const exits: VotingExit[] = value
    .filter((entry): entry is Record<string, unknown> => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        logger.warn(`[${repoFullName}] Invalid exit entry: expected object. Skipping.`);
        return false;
      }
      return true;
    })
    .map((entry) => {
      // Parse afterMinutes
      const afterMinutesRaw = entry.afterMinutes;
      let afterMs: number;
      if (typeof afterMinutesRaw !== "number" || !Number.isFinite(afterMinutesRaw)) {
        logger.warn(
          `[${repoFullName}] Invalid exit afterMinutes: expected number. Using default.`
        );
        afterMs = VOTING_DURATION_MS;
      } else {
        const clamped = clamp(afterMinutesRaw, bounds.min, bounds.max);
        if (clamped !== afterMinutesRaw) {
          logger.info(
            `[${repoFullName}] exit afterMinutes clamped from ${afterMinutesRaw} to ${clamped}`
          );
        }
        afterMs = clamped * MS_PER_MINUTE;
      }

      // Parse requires
      let requires: ExitRequires = "majority";
      if (entry.requires !== undefined && entry.requires !== null) {
        if (VALID_REQUIRES.includes(entry.requires as ExitRequires)) {
          requires = entry.requires as ExitRequires;
        } else {
          logger.warn(
            `[${repoFullName}] Invalid exit requires: "${String(entry.requires)}". Using default ("majority").`
          );
        }
      }

      // Parse per-exit minVoters (falls back to inherited default)
      const minVoters = (entry.minVoters !== undefined && entry.minVoters !== null)
        ? parseIntValue(entry.minVoters, MIN_VOTERS_BOUNDS, "exit.minVoters", repoFullName)
        : defaultMinVoters;

      // Parse per-exit requiredVoters (falls back to inherited default)
      const requiredVoters = (entry.requiredVoters !== undefined && entry.requiredVoters !== null)
        ? parseRequiredVotersConfig(entry.requiredVoters, repoFullName)
        : defaultRequiredVoters;

      return { afterMs, requires, minVoters, requiredVoters };
    });

  if (exits.length === 0) {
    logger.warn(
      `[${repoFullName}] All exit entries were invalid. Using default.`
    );
    return [defaultExit];
  }

  // Sort ascending by afterMs
  exits.sort((a, b) => a.afterMs - b.afterMs);

  return exits;
}

/**
 * Parse and validate a RepoConfigFile object.
 * Returns EffectiveConfig with all values validated and clamped.
 *
 * Supports the nested configuration format.
 */
function parseRepoConfig(raw: unknown, repoFullName: string): EffectiveConfig {
  const config = raw as RepoConfigFile | undefined;

  // Resolve discussion duration
  const discussionMinutesRaw =
    config?.governance?.proposals?.discussion?.durationMinutes;

  // Resolve PR settings
  const prConfig = config?.governance?.pr;

  // Voting-specific settings (only in new format)
  const votingConfig = config?.governance?.proposals?.voting;

  // Parse top-level minVoters/requiredVoters as defaults for exits that don't
  // specify their own.
  const topLevelMinVoters = parseIntValue(
    votingConfig?.minVoters,
    MIN_VOTERS_BOUNDS,
    "governance.proposals.voting.minVoters",
    repoFullName
  );
  const topLevelRequiredVoters = parseRequiredVotersConfig(
    votingConfig?.requiredVoters,
    repoFullName
  );

  // Exits (default applied if missing)
  const exitsRaw = votingConfig?.exits;

  const exits = parseExits(
    exitsRaw,
    repoFullName,
    topLevelMinVoters,
    topLevelRequiredVoters,
  );

  return {
    version: typeof config?.version === "number" ? config.version : 1,
    governance: {
      proposals: {
        discussion: {
          durationMs: parseDurationMinutes(
            discussionMinutesRaw,
            DISCUSSION_DURATION_BOUNDS,
            "governance.proposals.discussion.durationMinutes",
            repoFullName
          ),
        },
        voting: {
          exits,
          durationMs: exits[exits.length - 1].afterMs,
        },
      },
      pr: {
        staleDays: parseIntValue(
          prConfig?.staleDays,
          PR_STALE_DAYS_BOUNDS,
          "pr.staleDays",
          repoFullName
        ),
        maxPRsPerIssue: parseIntValue(
          prConfig?.maxPRsPerIssue,
          MAX_PRS_PER_ISSUE_BOUNDS,
          "pr.maxPRsPerIssue",
          repoFullName
        ),
      },
    },
  };
}

/**
 * Get the default configuration (env-derived, clamped to CONFIG_BOUNDS).
 */
export function getDefaultConfig(): EffectiveConfig {
  return {
    version: 1,
    governance: {
      proposals: {
        discussion: {
          durationMs: DISCUSSION_DURATION_MS,
        },
        voting: {
          exits: [{
            afterMs: VOTING_DURATION_MS,
            requires: "majority" as const,
            minVoters: CONFIG_BOUNDS.voting.minVoters.default,
            requiredVoters: { mode: "all" as const, voters: [] },
          }],
          durationMs: VOTING_DURATION_MS,
        },
      },
      pr: {
        staleDays: PR_STALE_THRESHOLD_DAYS,
        maxPRsPerIssue: MAX_PRS_PER_ISSUE,
      },
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
