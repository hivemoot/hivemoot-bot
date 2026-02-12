import { describe, it, expect } from "vitest";
import { hasLabel, filterByLabel } from "./types.js";
import type { LinkedIssue } from "./types.js";

/**
 * Tests for type utility functions
 */

describe("types utilities", () => {
  const createLinkedIssue = (number: number, labels: string[]): LinkedIssue => ({
    number,
    title: `Issue #${number}`,
    state: "OPEN",
    labels: {
      nodes: labels.map((name) => ({ name })),
    },
  });

  describe("hasLabel", () => {
    it("should return true when issue has the label", () => {
      const issue = createLinkedIssue(1, ["bug", "phase:discussion"]);
      expect(hasLabel(issue, "bug")).toBe(true);
      expect(hasLabel(issue, "phase:discussion")).toBe(true);
    });

    it("should return false when issue does not have the label", () => {
      const issue = createLinkedIssue(1, ["bug", "enhancement"]);
      expect(hasLabel(issue, "phase:discussion")).toBe(false);
    });

    it("should return false for empty labels array", () => {
      const issue = createLinkedIssue(1, []);
      expect(hasLabel(issue, "any-label")).toBe(false);
    });

    it("should be case-sensitive", () => {
      const issue = createLinkedIssue(1, ["Bug"]);
      expect(hasLabel(issue, "bug")).toBe(false);
      expect(hasLabel(issue, "Bug")).toBe(true);
    });

    it("should handle labels with special characters", () => {
      const issue = createLinkedIssue(1, ["phase:ready-to-implement"]);
      expect(hasLabel(issue, "phase:ready-to-implement")).toBe(true);
    });

    it("should ignore malformed label nodes", () => {
      const malformedIssue = {
        number: 1,
        title: "Malformed",
        state: "OPEN",
        labels: {
          nodes: [
            { name: "bug" },
            null,
            { name: null },
          ],
        },
      } as unknown as LinkedIssue;

      expect(hasLabel(malformedIssue, "bug")).toBe(true);
      expect(hasLabel(malformedIssue, "phase:discussion")).toBe(false);
    });
  });

  describe("filterByLabel", () => {
    it("should return issues with the specified label", () => {
      const issues = [
        createLinkedIssue(1, ["bug", "phase:discussion"]),
        createLinkedIssue(2, ["enhancement"]),
        createLinkedIssue(3, ["bug", "phase:voting"]),
      ];

      const bugIssues = filterByLabel(issues, "bug");
      expect(bugIssues).toHaveLength(2);
      expect(bugIssues.map((i) => i.number)).toEqual([1, 3]);
    });

    it("should return empty array when no issues match", () => {
      const issues = [
        createLinkedIssue(1, ["bug"]),
        createLinkedIssue(2, ["enhancement"]),
      ];

      const result = filterByLabel(issues, "phase:discussion");
      expect(result).toEqual([]);
    });

    it("should return empty array for empty input", () => {
      const result = filterByLabel([], "any-label");
      expect(result).toEqual([]);
    });

    it("should filter phase:ready-to-implement issues correctly", () => {
      const issues = [
        createLinkedIssue(1, ["phase:ready-to-implement"]),
        createLinkedIssue(2, ["phase:discussion"]),
        createLinkedIssue(3, ["phase:ready-to-implement", "priority:high"]),
      ];

      const readyIssues = filterByLabel(issues, "phase:ready-to-implement");
      expect(readyIssues).toHaveLength(2);
      expect(readyIssues.map((i) => i.number)).toEqual([1, 3]);
    });

    it("should preserve issue object references", () => {
      const issue1 = createLinkedIssue(1, ["bug"]);
      const issues = [issue1];

      const result = filterByLabel(issues, "bug");
      expect(result[0]).toBe(issue1);
    });
  });
});
