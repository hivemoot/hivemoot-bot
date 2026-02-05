import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadRepositoryConfig, getDefaultConfig } from "./repo-config.js";
import {
  CONFIG_BOUNDS,
  DISCUSSION_DURATION_MS,
  VOTING_DURATION_MS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
} from "../config.js";

/**
 * Tests for repo-config.ts
 *
 * Verifies config loading from .github/hivemoot.yml, including:
 * - Valid config parsing (new format)
 * - Partial configs with defaults
 * - Missing files (404)
 * - Invalid YAML
 * - Boundary clamping
 * - requiredVoters (mode/voters) and exits validation
 */

const MS = 60 * 1000;
const defaultDurationMs = VOTING_DURATION_MS;

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

      expect(defaults.governance.proposals.discussion.durationMs).toBe(DISCUSSION_DURATION_MS);
      expect(defaults.governance.proposals.voting.exits).toEqual([
        {
          afterMs: defaultDurationMs,
          requires: "majority",
          minVoters: CONFIG_BOUNDS.voting.minVoters.default,
          requiredVoters: { mode: "all", voters: [] },
        },
      ]);
      expect(defaults.governance.proposals.voting.durationMs).toBe(defaultDurationMs);
      expect(defaults.governance.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
      expect(defaults.governance.pr.maxPRsPerIssue).toBe(MAX_PRS_PER_ISSUE);
    });
  });

  describe("loadRepositoryConfig", () => {
    describe("new format config parsing", () => {
      it("should parse complete new format config with exits", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      durationMinutes: 120
    voting:
      exits:
        - afterMinutes: 15
          requires: unanimous
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - seed-scout
              - seed-worker
        - afterMinutes: 60
          minVoters: 2
          requiredVoters:
            mode: any
            voters:
              - seed-scout
              - seed-worker
        - afterMinutes: 360
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - seed-scout
              - seed-worker
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.version).toBe(1);
        expect(config.governance.proposals.discussion.durationMs).toBe(120 * MS);
        expect(config.governance.proposals.voting.exits).toEqual([
          { afterMs: 15 * MS, requires: "unanimous", minVoters: 3, requiredVoters: { mode: "all", voters: ["seed-scout", "seed-worker"] } },
          { afterMs: 60 * MS, requires: "majority", minVoters: 2, requiredVoters: { mode: "any", voters: ["seed-scout", "seed-worker"] } },
          { afterMs: 360 * MS, requires: "majority", minVoters: 3, requiredVoters: { mode: "all", voters: ["seed-scout", "seed-worker"] } },
        ]);
        // durationMs derived from last exit
        expect(config.governance.proposals.voting.durationMs).toBe(360 * MS);
        expect(config.governance.pr.staleDays).toBe(3);
        expect(config.governance.pr.maxPRsPerIssue).toBe(3);
      });

      it("should default to single exit when exits not specified", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(config.governance.proposals.voting.exits[0].requires).toBe("majority");
        // Top-level minVoters should be inherited into the default exit
        expect(config.governance.proposals.voting.exits[0].minVoters).toBe(2);
        expect(config.governance.proposals.voting.durationMs).toBe(defaultDurationMs);
      });

      it("should default requiredVoters to mode:all, voters:[] when not specified", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        // Default exit should inherit the default requiredVoters
        expect(config.governance.proposals.voting.exits[0].requiredVoters).toEqual({ mode: "all", voters: [] });
      });

      it("should parse requiredVoters with mode: any (inherited into exits)", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        mode: any
        voters:
          - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        // Top-level requiredVoters inherited into the default exit
        expect(config.governance.proposals.voting.exits[0].requiredVoters).toEqual({
          mode: "any",
          voters: ["alice"],
        });
      });

      it("should default invalid requiredVoters mode to 'all'", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        mode: invalid
        voters:
          - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.mode).toBe("all");
      });

      it("should default missing mode to 'all'", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.mode).toBe("all");
        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["alice"]);
      });

      it("should handle array shorthand for requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        - seed-scout
        - seed-worker
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters).toEqual({
          mode: "all",
          voters: ["seed-scout", "seed-worker"],
        });
      });

      it("should lowercase and deduplicate requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        mode: all
        voters:
          - Seed-Scout
          - seed-scout
          - SEED-WORKER
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should strip leading @ from requiredVoters entries", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - "@seed-scout"
          - "@Seed-Worker"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should trim whitespace from requiredVoters entries", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - "  seed-scout  "
          - "seed-worker "
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should skip entries that are only @ or whitespace", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - "@"
          - "  "
          - valid-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip invalid GitHub usernames in requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - "-bad"
          - "bad-"
          - "bad..name"
          - "valid-user"
          - "also--bad"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip requiredVoters entries that exceed max username length", async () => {
        const tooLong = "a".repeat(CONFIG_BOUNDS.requiredVoters.maxUsernameLength + 1);
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - ${tooLong}
          - valid-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip non-string entries in requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - valid-user
          - 123
          - ""
          - another-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["valid-user", "another-user"]);
      });

      it("should handle requiredVoters without exits", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters:
        voters:
          - agent-one
          - agent-two
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        // Default single exit inherits top-level requiredVoters
        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(config.governance.proposals.voting.exits[0].requiredVoters.voters).toEqual(["agent-one", "agent-two"]);
      });
    });

    describe("exits parsing", () => {
      it("should parse single exit and derive durationMs", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 120
          minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(config.governance.proposals.voting.exits[0]).toEqual({
          afterMs: 120 * MS,
          requires: "majority",
          minVoters: 2,
          requiredVoters: { mode: "all", voters: [] },
        });
        expect(config.governance.proposals.voting.durationMs).toBe(120 * MS);
      });

      it("should sort multiple exits ascending by afterMinutes", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 360
        - afterMinutes: 15
        - afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(3);
        expect(config.governance.proposals.voting.exits[0].afterMs).toBe(15 * MS);
        expect(config.governance.proposals.voting.exits[1].afterMs).toBe(60 * MS);
        expect(config.governance.proposals.voting.exits[2].afterMs).toBe(360 * MS);
        // deadline = last exit
        expect(config.governance.proposals.voting.durationMs).toBe(360 * MS);
      });

      it("should preserve requires: unanimous", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 15
          requires: unanimous
        - afterMinutes: 360
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requires).toBe("unanimous");
        expect(config.governance.proposals.voting.exits[1].requires).toBe("majority");
      });

      it("should default missing requires to majority", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requires).toBe("majority");
      });

      it("should default invalid requires to majority", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 60
          requires: supermajority
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requires).toBe("majority");
      });

      it("should parse per-exit requiredVoters and minVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 60
          minVoters: 5
          requiredVoters:
            mode: any
            voters:
              - alice
              - bob
        - afterMinutes: 360
          minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters).toEqual({
          mode: "any",
          voters: ["alice", "bob"],
        });
        expect(config.governance.proposals.voting.exits[0].minVoters).toBe(5);
        // Second exit: no requiredVoters specified, inherits default
        expect(config.governance.proposals.voting.exits[1].requiredVoters).toEqual({ mode: "all", voters: [] });
        expect(config.governance.proposals.voting.exits[1].minVoters).toBe(2);
      });

      it("should allow different exits with different minVoters/requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 15
          requires: unanimous
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - alice
              - bob
        - afterMinutes: 360
          minVoters: 1
          requiredVoters:
            mode: any
            voters:
              - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].minVoters).toBe(3);
        expect(config.governance.proposals.voting.exits[0].requiredVoters.mode).toBe("all");
        expect(config.governance.proposals.voting.exits[1].minVoters).toBe(1);
        expect(config.governance.proposals.voting.exits[1].requiredVoters.mode).toBe("any");
      });

      it("should clamp exit afterMinutes per exit", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - afterMinutes: 0
        - afterMinutes: 999999999
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const minMs = CONFIG_BOUNDS.phaseDurationMinutes.min * MS;
        const maxMs = CONFIG_BOUNDS.phaseDurationMinutes.max * MS;
        expect(config.governance.proposals.voting.exits[0].afterMs).toBe(minMs);
        expect(config.governance.proposals.voting.exits[1].afterMs).toBe(maxMs);
      });

      it("should use default single exit for empty array", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits: []
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(config.governance.proposals.voting.exits[0].afterMs).toBe(defaultDurationMs);
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
  proposals:
    discussion:
      durationMinutes: 60
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
  proposals:
    discussion:
      durationMinutes: "not a number"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.durationMs).toBe(DISCUSSION_DURATION_MS);
      });

      it("should use default when staleDays is an object", async () => {
        const configYaml = `
governance:
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

        expect(config.governance.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
      });

      it("should use default when requiredVoters is a plain string", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      requiredVoters: "not-valid"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].requiredVoters).toEqual({ mode: "all", voters: [] });
      });
    });

    describe("boundary clamping", () => {
      it("should clamp discussion duration below minimum to minimum", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      durationMinutes: 0
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const minMs = CONFIG_BOUNDS.phaseDurationMinutes.min * MS;
        expect(config.governance.proposals.discussion.durationMs).toBe(minMs);
      });

      it("should clamp duration above maximum to maximum", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      durationMinutes: 999999999
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const maxMs = CONFIG_BOUNDS.phaseDurationMinutes.max * MS;
        expect(config.governance.proposals.discussion.durationMs).toBe(maxMs);
      });

      it("should clamp staleDays to boundaries", async () => {
        const configYaml = `
governance:
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

        expect(config.governance.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.min);
      });

      it("should clamp maxPRsPerIssue above maximum to maximum", async () => {
        const configYaml = `
governance:
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

        expect(config.governance.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.max);
      });

      it("should clamp minVoters to boundaries (top-level inherited into exit)", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      minVoters: 100
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits[0].minVoters).toBe(CONFIG_BOUNDS.voting.minVoters.max);
      });

      it("should allow values at exact boundaries", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      durationMinutes: ${CONFIG_BOUNDS.phaseDurationMinutes.min}
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

        expect(config.governance.proposals.discussion.durationMs).toBe(
          CONFIG_BOUNDS.phaseDurationMinutes.min * MS
        );
        expect(config.governance.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.max);
        expect(config.governance.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.min);
      });

      it("should round non-integer staleDays to nearest integer", async () => {
        const configYaml = `
governance:
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

        expect(config.governance.pr.staleDays).toBe(4);
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
