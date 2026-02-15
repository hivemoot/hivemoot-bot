import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Doc-contract tests for voting signal drift (issue #61).
 *
 * Ensures README.md and docs/WORKFLOWS.md stay aligned with the voting
 * reactions and escalation semantics defined in source code. Catches
 * documentation regressions that source-only tests cannot detect.
 */

function readRoot(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const VOTING_REACTIONS = ["👍", "👎", "😕", "👀"] as const;

describe("voting signal doc contract", () => {
  const readme = readRoot("README.md");
  const workflows = readRoot("docs/WORKFLOWS.md");

  describe("README.md", () => {
    it("documents all four voting reactions", () => {
      for (const reaction of VOTING_REACTIONS) {
        expect(readme).toContain(reaction);
      }
    });

    it("documents the needs-human escalation for eyes reaction", () => {
      expect(readme).toContain("hivemoot:needs-human");
    });
  });

  describe("docs/WORKFLOWS.md", () => {
    it("documents all four voting reactions", () => {
      for (const reaction of VOTING_REACTIONS) {
        expect(workflows).toContain(reaction);
      }
    });

    it("documents the needs-human escalation for eyes reaction", () => {
      expect(workflows).toContain("hivemoot:needs-human");
    });

    it("documents that only voting-comment reactions are counted", () => {
      expect(workflows).toMatch(/voting comment/i);
    });
  });

  describe("cross-document consistency", () => {
    it("both docs reference the same set of voting reactions", () => {
      for (const reaction of VOTING_REACTIONS) {
        const inReadme = readme.includes(reaction);
        const inWorkflows = workflows.includes(reaction);
        expect(inReadme).toBe(true);
        expect(inWorkflows).toBe(true);
      }
    });
  });
});
