import { describe, it, expect } from "vitest";
import {
  validateClient,
  hasPaginateIterator,
  ISSUE_CLIENT_CHECKS,
  PR_CLIENT_CHECKS,
  LEADERBOARD_CLIENT_CHECKS,
} from "./client-validation.js";

describe("client-validation", () => {
  describe("validateClient", () => {
    it("returns false for non-object inputs", () => {
      expect(validateClient(null, [])).toBe(false);
      expect(validateClient(undefined, [])).toBe(false);
      expect(validateClient("octokit", [])).toBe(false);
      expect(validateClient(42, [])).toBe(false);
    });

    it("validates required methods at nested paths", () => {
      const client = {
        rest: {
          issues: {
            get: () => undefined,
            createComment: () => undefined,
          },
        },
      };

      expect(
        validateClient(client, [
          { path: "rest.issues", requiredMethods: ["get", "createComment"] },
        ])
      ).toBe(true);
    });

    it("fails when a required nested path is missing", () => {
      const client = { rest: {} };

      expect(
        validateClient(client, [
          { path: "rest.issues", requiredMethods: ["get"] },
        ])
      ).toBe(false);
    });

    it("fails when a required method is missing or not a function", () => {
      const missingMethodClient = {
        rest: {
          issues: {
            get: () => undefined,
          },
        },
      };
      const nonFunctionMethodClient = {
        rest: {
          issues: {
            get: () => undefined,
            createComment: "not-a-function",
          },
        },
      };

      expect(
        validateClient(missingMethodClient, [
          { path: "rest.issues", requiredMethods: ["get", "createComment"] },
        ])
      ).toBe(false);
      expect(
        validateClient(nonFunctionMethodClient, [
          { path: "rest.issues", requiredMethods: ["get", "createComment"] },
        ])
      ).toBe(false);
    });

    it("treats checks without requiredMethods as path-existence checks", () => {
      const validClient = {
        rest: {
          issues: {
            get: () => undefined,
          },
        },
      };
      const invalidClient = {
        rest: {
          issues: null,
        },
      };

      expect(validateClient(validClient, [{ path: "rest.issues" }])).toBe(true);
      expect(validateClient(invalidClient, [{ path: "rest.issues" }])).toBe(false);
    });

    it("requires all checks to pass", () => {
      const client = {
        rest: {
          issues: {
            get: () => undefined,
            createComment: () => undefined,
          },
        },
      };

      expect(
        validateClient(client, [
          { path: "rest.issues", requiredMethods: ["get", "createComment"] },
          { path: "rest.reactions", requiredMethods: ["listForIssue"] },
        ])
      ).toBe(false);
    });
  });

  describe("hasPaginateIterator", () => {
    it("returns true when paginate is an object with iterator()", () => {
      const client = {
        paginate: {
          iterator: () => undefined,
        },
      };
      expect(hasPaginateIterator(client)).toBe(true);
    });

    it("returns true when paginate is a function with iterator() property", () => {
      const paginate = Object.assign(() => undefined, {
        iterator: () => undefined,
      });
      const client = { paginate };

      expect(hasPaginateIterator(client)).toBe(true);
    });

    it("returns false when paginate is absent or iterator is not callable", () => {
      expect(hasPaginateIterator({})).toBe(false);
      expect(hasPaginateIterator({ paginate: null })).toBe(false);
      expect(hasPaginateIterator({ paginate: { iterator: "nope" } })).toBe(false);
    });

    it("returns false for non-object inputs", () => {
      expect(hasPaginateIterator(null)).toBe(false);
      expect(hasPaginateIterator("octokit")).toBe(false);
    });
  });

  describe("exported client check sets", () => {
    it("includes expected issue operations methods", () => {
      expect(ISSUE_CLIENT_CHECKS).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "rest.issues",
            requiredMethods: expect.arrayContaining(["get", "createComment", "lock", "unlock"]),
          }),
          expect.objectContaining({
            path: "rest.reactions",
            requiredMethods: expect.arrayContaining(["listForIssue", "listForIssueComment"]),
          }),
        ])
      );
    });

    it("includes expected PR operations methods", () => {
      expect(PR_CLIENT_CHECKS).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "rest.pulls",
            requiredMethods: expect.arrayContaining(["listReviews", "listCommits"]),
          }),
          expect.objectContaining({
            path: "rest.issues",
            requiredMethods: expect.arrayContaining(["listForRepo", "listComments"]),
          }),
          expect.objectContaining({
            path: "rest.checks",
            requiredMethods: expect.arrayContaining(["listForRef"]),
          }),
          expect.objectContaining({
            path: "rest.repos",
            requiredMethods: expect.arrayContaining(["getCombinedStatusForRef"]),
          }),
        ])
      );
    });

    it("includes expected leaderboard methods", () => {
      expect(LEADERBOARD_CLIENT_CHECKS).toEqual([
        expect.objectContaining({
          path: "rest.issues",
          requiredMethods: ["listComments", "createComment", "updateComment"],
        }),
      ]);
    });
  });
});
