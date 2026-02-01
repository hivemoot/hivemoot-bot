import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadRepositoryConfig, getDefaultConfig } from "./repo-config.js";
import {
  CONFIG_BOUNDS,
  DISCUSSION_DURATION_MS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
  VOTING_DURATION_MS,
} from "../config.js";

/**
 * Tests for repo-config.ts
 *
 * Verifies config loading from .github/hivemoot.yml, including:
 * - Valid config parsing
 * - Partial configs with defaults
 * - Missing files (404)
 * - Invalid YAML
 * - Boundary clamping
 */

// Helper to encode content as base64
function encodeBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

// Helper to create a mock Octokit client
function createMockOctokit(response: {
  data?: { type?: string; content?: string; encoding?: string };
  error?: { status: number; message: string };
}) {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockImplementation(() => {
          if (response.error) {
            const error = new Error(response.error.message) as Error & { status: number };
            error.status = response.error.status;
            return Promise.reject(error);
          }
          return Promise.resolve({ data: response.data });
        }),
      },
    },
  };
}

describe("repo-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultConfig", () => {
    it("should return default values from env-derived config", () => {
      const defaults = getDefaultConfig();

      expect(defaults.governance.discussionDurationMs).toBe(DISCUSSION_DURATION_MS);
      expect(defaults.governance.votingDurationMs).toBe(VOTING_DURATION_MS);
      expect(defaults.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
      expect(defaults.pr.maxPRsPerIssue).toBe(MAX_PRS_PER_ISSUE);
    });
  });

  describe("loadRepositoryConfig", () => {
    describe("valid config parsing", () => {
      it("should parse a complete valid config", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: 60
  votingDurationMinutes: 120
pr:
  staleDays: 5
  maxPRsPerIssue: 5
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.discussionDurationMs).toBe(60 * 60 * 1000);
        expect(config.governance.votingDurationMs).toBe(120 * 60 * 1000);
        expect(config.pr.staleDays).toBe(5);
        expect(config.pr.maxPRsPerIssue).toBe(5);
      });

      it("should parse minimal config with only governance section", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: 30
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.discussionDurationMs).toBe(30 * 60 * 1000);
        // Voting duration should use default
        expect(config.governance.votingDurationMs).toBe(VOTING_DURATION_MS);
        // PR settings should use defaults
        expect(config.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
        expect(config.pr.maxPRsPerIssue).toBe(MAX_PRS_PER_ISSUE);
      });

      it("should parse minimal config with only pr section", async () => {
        const configYaml = `
pr:
  staleDays: 7
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.pr.staleDays).toBe(7);
        // Other PR setting should use default
        expect(config.pr.maxPRsPerIssue).toBe(MAX_PRS_PER_ISSUE);
        // Governance settings should use defaults
        expect(config.governance.discussionDurationMs).toBe(DISCUSSION_DURATION_MS);
      });
    });

    describe("missing file handling", () => {
      it("should return defaults when config file not found (404)", async () => {
        const octokit = createMockOctokit({
          error: { status: 404, message: "Not Found" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults for empty file", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(""),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when path is a directory", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "dir",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });

    describe("invalid YAML handling", () => {
      it("should return defaults for invalid YAML syntax", async () => {
        const invalidYaml = `
governance:
  discussionDurationMinutes: 60
  - this is invalid
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(invalidYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when YAML is not an object", async () => {
        const arrayYaml = `
- item1
- item2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(arrayYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when YAML is a string", async () => {
        const stringYaml = "just a string";
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(stringYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });

    describe("invalid value types", () => {
      it("should use default when duration is a string", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: "not a number"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.discussionDurationMs).toBe(DISCUSSION_DURATION_MS);
      });

      it("should use default when staleDays is an object", async () => {
        const configYaml = `
pr:
  staleDays:
    min: 1
    max: 10
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
      });
    });

    describe("boundary clamping", () => {
      it("should clamp duration below minimum to minimum", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: 0
  votingDurationMinutes: -100
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const minMs = CONFIG_BOUNDS.phaseDurationMinutes.min * 60 * 1000;
        expect(config.governance.discussionDurationMs).toBe(minMs);
        expect(config.governance.votingDurationMs).toBe(minMs);
      });

      it("should clamp duration above maximum to maximum", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: 999999999
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const maxMs = CONFIG_BOUNDS.phaseDurationMinutes.max * 60 * 1000;
        expect(config.governance.discussionDurationMs).toBe(maxMs);
      });

      it("should clamp staleDays to boundaries", async () => {
        const configYaml = `
pr:
  staleDays: 0
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.min);
      });

      it("should clamp maxPRsPerIssue above maximum to maximum", async () => {
        const configYaml = `
pr:
  maxPRsPerIssue: 100
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.max);
      });

      it("should allow values at exact boundaries", async () => {
        const configYaml = `
governance:
  discussionDurationMinutes: ${CONFIG_BOUNDS.phaseDurationMinutes.min}
  votingDurationMinutes: ${CONFIG_BOUNDS.phaseDurationMinutes.max}
pr:
  staleDays: ${CONFIG_BOUNDS.prStaleDays.max}
  maxPRsPerIssue: ${CONFIG_BOUNDS.maxPRsPerIssue.min}
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.discussionDurationMs).toBe(
          CONFIG_BOUNDS.phaseDurationMinutes.min * 60 * 1000
        );
        expect(config.governance.votingDurationMs).toBe(
          CONFIG_BOUNDS.phaseDurationMinutes.max * 60 * 1000
        );
        expect(config.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.max);
        expect(config.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.min);
      });

      it("should round non-integer staleDays to nearest integer", async () => {
        const configYaml = `
pr:
  staleDays: 3.7
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.pr.staleDays).toBe(4);
      });
    });

    describe("API error handling", () => {
      it("should return defaults on 403 forbidden error", async () => {
        const octokit = createMockOctokit({
          error: { status: 403, message: "Forbidden" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults on 500 server error", async () => {
        const octokit = createMockOctokit({
          error: { status: 500, message: "Internal Server Error" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });
  });
});
