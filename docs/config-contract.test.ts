import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_BOUNDS } from "../api/config.js";

/**
 * Doc-contract test: verifies CONFIG.md stays in sync with the actual
 * configuration schema and validation boundaries.
 *
 * If this test fails, update docs/CONFIG.md to match the current schema.
 */

const configDoc = readFileSync(
  resolve(import.meta.dirname, "CONFIG.md"),
  "utf-8"
);

describe("docs/CONFIG.md contract", () => {
  describe("documents all governance.proposals phases", () => {
    for (const phase of ["discussion", "voting", "extendedVoting"]) {
      it(`documents ${phase} exits`, () => {
        expect(configDoc).toContain(phase);
      });
    }
  });

  describe("documents all exit types", () => {
    it("documents manual exit type", () => {
      expect(configDoc).toContain("manual");
    });

    it("documents auto exit type", () => {
      expect(configDoc).toContain("auto");
    });
  });

  describe("documents voting exit fields", () => {
    for (const field of ["afterMinutes", "requires", "minVoters", "requiredVoters"]) {
      it(`documents ${field}`, () => {
        expect(configDoc).toContain(field);
      });
    }

    it("documents requires values", () => {
      expect(configDoc).toContain("majority");
      expect(configDoc).toContain("unanimous");
    });
  });

  describe("documents discussion exit fields", () => {
    for (const field of ["afterMinutes", "minReady", "requiredReady"]) {
      it(`documents ${field}`, () => {
        expect(configDoc).toContain(field);
      });
    }
  });

  describe("documents PR config fields", () => {
    for (const field of ["staleDays", "maxPRsPerIssue", "trustedReviewers", "intake", "mergeReady"]) {
      it(`documents ${field}`, () => {
        expect(configDoc).toContain(field);
      });
    }
  });

  describe("documents intake methods", () => {
    for (const method of ["update", "approval"]) {
      it(`documents method: ${method}`, () => {
        expect(configDoc).toContain(method);
      });
    }

    it("documents minApprovals for approval method", () => {
      expect(configDoc).toContain("minApprovals");
    });
  });

  describe("documents standup config", () => {
    for (const field of ["enabled", "category"]) {
      it(`documents standup.${field}`, () => {
        expect(configDoc).toContain(field);
      });
    }
  });

  describe("documents validation boundaries", () => {
    it("documents phase duration bounds", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.phaseDurationMinutes.min));
      expect(configDoc).toContain(String(CONFIG_BOUNDS.phaseDurationMinutes.max));
    });

    it("documents PR stale days bounds", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.prStaleDays.min));
      expect(configDoc).toContain(String(CONFIG_BOUNDS.prStaleDays.max));
    });

    it("documents max PRs per issue bounds", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.maxPRsPerIssue.min));
      expect(configDoc).toContain(String(CONFIG_BOUNDS.maxPRsPerIssue.max));
    });

    it("documents min voters bounds", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.voting.minVoters.max));
    });

    it("documents merge-ready min approvals bounds", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.mergeReady.minApprovals.max));
    });

    it("documents required voters max entries", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.requiredVoters.maxEntries));
    });

    it("documents max username length", () => {
      expect(configDoc).toContain(String(CONFIG_BOUNDS.requiredVoters.maxUsernameLength));
    });
  });

  describe("documents all environment variables", () => {
    for (const envVar of [
      "APP_ID",
      "PRIVATE_KEY",
      "APP_PRIVATE_KEY",
      "WEBHOOK_SECRET",
      "HIVEMOOT_DISCUSSION_DURATION_MINUTES",
      "HIVEMOOT_VOTING_DURATION_MINUTES",
      "HIVEMOOT_PR_STALE_DAYS",
      "HIVEMOOT_MAX_PRS_PER_ISSUE",
    ]) {
      it(`documents ${envVar}`, () => {
        expect(configDoc).toContain(envVar);
      });
    }
  });

  describe("documents LLM environment variables", () => {
    for (const envVar of [
      "LLM_PROVIDER",
      "LLM_MODEL",
      "LLM_MAX_TOKENS",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "MISTRAL_API_KEY",
    ]) {
      it(`documents ${envVar}`, () => {
        expect(configDoc).toContain(envVar);
      });
    }
  });
});
