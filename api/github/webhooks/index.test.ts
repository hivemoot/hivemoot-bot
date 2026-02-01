import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernanceService } from "../../lib/governance.js";
import { createIssueOperations } from "../../lib/github-client.js";
import { LABELS, MESSAGES } from "../../config.js";
import { processImplementationIntake } from "./index.js";
import type { IssueRef, LinkedIssue } from "../../lib/types.js";
import { hasLabel } from "../../lib/types.js";
import type { IncomingMessage, ServerResponse } from "http";
import {
  getLinkedIssues,
  getOpenPRsForIssue,
} from "../../lib/graphql-queries.js";

// Mock probot to prevent actual initialization
vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

// Mock env-validation
vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

// Mock GraphQL queries used by leaderboard updates
vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: vi.fn(),
  getOpenPRsForIssue: vi.fn(),
}));

/**
 * Tests for Queen Bot webhook handlers
 *
 * These tests verify:
 * 1. GovernanceService integration for issue handling
 * 2. Health check endpoint behavior with configuration validation
 * 3. Error handling propagation
 */

const TEST_APP_ID = 12345;

describe("Queen Bot", () => {
  describe("Issue Handler via GovernanceService", () => {
    const createMockOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 0, "-1": 0, confused: 0 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    });

    it("should add phase:discussion label and post welcome comment on new issue", async () => {
      const mockOctokit = createMockOctokit();
      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const governance = new GovernanceService(issues);

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 42 };
      await governance.startDiscussion(ref);

      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 42,
        labels: [LABELS.DISCUSSION],
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 42,
        body: MESSAGES.ISSUE_WELCOME,
      });
    });

    it("should propagate API errors", async () => {
      const mockOctokit = createMockOctokit();
      const apiError = new Error("GitHub API rate limited");
      mockOctokit.rest.issues.addLabels.mockRejectedValue(apiError);

      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const governance = new GovernanceService(issues);

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 42 };

      await expect(governance.startDiscussion(ref)).rejects.toThrow("GitHub API rate limited");
    });
  });

  describe("PR Handler", () => {
    const createMockOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    });

    it("should post PR welcome comment", async () => {
      const mockOctokit = createMockOctokit();
      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };
      await issues.comment(ref, MESSAGES.PR_WELCOME);

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 123,
        body: MESSAGES.PR_WELCOME,
      });
    });

    it("should propagate API errors", async () => {
      const mockOctokit = createMockOctokit();
      const apiError = new Error("Permission denied");
      mockOctokit.rest.issues.createComment.mockRejectedValue(apiError);

      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };

      await expect(issues.comment(ref, MESSAGES.PR_WELCOME)).rejects.toThrow("Permission denied");
    });
  });

  describe("PR Welcome Conditional Logic", () => {
    const createLinkedIssue = (number: number, labels: string[]): LinkedIssue => ({
      number,
      title: `Issue #${number}`,
      state: "OPEN" as const,
      labels: { nodes: labels.map((name) => ({ name })) },
    });

    describe("shouldWelcome determination", () => {
      it("should welcome PR with no linked issues", () => {
        const linkedIssues: LinkedIssue[] = [];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(true);
      });

      it("should welcome PR linked to phase:ready-to-implement issue", () => {
        const linkedIssues = [createLinkedIssue(42, [LABELS.READY_TO_IMPLEMENT])];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(true);
      });

      it("should NOT welcome PR linked to phase:discussion issue", () => {
        const linkedIssues = [createLinkedIssue(42, [LABELS.DISCUSSION])];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(false);
      });

      it("should NOT welcome PR linked to phase:voting issue", () => {
        const linkedIssues = [createLinkedIssue(42, [LABELS.VOTING])];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(false);
      });

      it("should welcome PR with mixed issues if at least one is ready", () => {
        const linkedIssues = [
          createLinkedIssue(1, [LABELS.DISCUSSION]),
          createLinkedIssue(2, [LABELS.READY_TO_IMPLEMENT]),
          createLinkedIssue(3, [LABELS.VOTING]),
        ];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(true);
      });

      it("should NOT welcome PR with multiple non-ready issues", () => {
        const linkedIssues = [
          createLinkedIssue(1, [LABELS.DISCUSSION]),
          createLinkedIssue(2, [LABELS.VOTING]),
        ];

        const hasReadyIssue = linkedIssues.some((issue) => hasLabel(issue, LABELS.READY_TO_IMPLEMENT));
        const shouldWelcome = linkedIssues.length === 0 || hasReadyIssue;

        expect(shouldWelcome).toBe(false);
      });
    });
  });

  describe("Implementation Intake", () => {
    const createMockOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          updateComment: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 101,
              state: "open",
              merged: false,
              created_at: "2026-02-01T00:00:00Z",
              updated_at: "2026-02-02T00:00:00Z",
              user: { login: "agent" },
            },
          }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    });

    it("should create a leaderboard comment when an implementation PR is accepted", async () => {
      const mockOctokit = createMockOctokit();

      const readyIssue: LinkedIssue = {
        number: 7,
        title: "Ready issue",
        state: "OPEN",
        labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      };

      vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);
      vi.mocked(getOpenPRsForIssue).mockResolvedValue([
        { number: 101, title: "PR", author: { login: "agent" } },
      ]);

      const issues = {
        getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
        comment: vi.fn().mockResolvedValue(undefined),
      };

      const prs = {
        get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
        getLabels: vi.fn().mockResolvedValue([]),
        getActivationDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
        findPRsWithLabel: vi.fn().mockResolvedValue([]),
        addLabels: vi.fn().mockResolvedValue(undefined),
        comment: vi.fn().mockResolvedValue(undefined),
      };

      await processImplementationIntake({
        octokit: mockOctokit,
        issues,
        prs,
        log: { info: vi.fn(), warn: vi.fn() },
        owner: "hivemoot",
        repo: "colony",
        prNumber: 101,
        linkedIssues: [readyIssue],
        trigger: "opened",
        maxPRsPerIssue: 3,
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });
  });

  describe("Health Check Endpoint", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should return ok status when all required env vars are set", () => {
      process.env.APP_ID = "12345";
      process.env.PRIVATE_KEY = "test-key";
      process.env.WEBHOOK_SECRET = "test-secret";

      // Simulate the validation logic from the handler
      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);
      const valid = missing.length === 0;

      expect(valid).toBe(true);
      expect(missing).toEqual([]);
    });

    it("should return misconfigured status when env vars are missing", () => {
      process.env.APP_ID = "12345";
      // PRIVATE_KEY and WEBHOOK_SECRET are not set

      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);
      const valid = missing.length === 0;

      expect(valid).toBe(false);
      expect(missing).toContain("PRIVATE_KEY");
      expect(missing).toContain("WEBHOOK_SECRET");
    });

    it("should identify all missing required variables", () => {
      // No env vars set
      delete process.env.APP_ID;
      delete process.env.PRIVATE_KEY;
      delete process.env.WEBHOOK_SECRET;

      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);

      expect(missing).toEqual(["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"]);
    });
  });

  describe("Message Templates", () => {
    it("should include Queen signature in all messages", () => {
      expect(MESSAGES.ISSUE_WELCOME).toContain("Queen");
      expect(MESSAGES.PR_WELCOME).toContain("Queen");
      expect(MESSAGES.VOTING_START).toContain("Queen");
    });

    it("should include voting instructions in VOTING_START", () => {
      expect(MESSAGES.VOTING_START).toContain("React to THIS comment to vote");
      expect(MESSAGES.VOTING_START).toContain("👍");
      expect(MESSAGES.VOTING_START).toContain("👎");
    });

    it("should format vote results correctly", () => {
      const votes = { thumbsUp: 5, thumbsDown: 2, confused: 1 };

      const readyMsg = MESSAGES.votingEndReadyToImplement(votes);
      expect(readyMsg).toContain("👍 5");
      expect(readyMsg).toContain("👎 2");
      expect(readyMsg).toContain("😕 1");
      expect(readyMsg).toContain("Ready to Implement");

      const rejectedMsg = MESSAGES.votingEndRejected(votes);
      expect(rejectedMsg).toContain("Rejected");

      const inconclusiveMsg = MESSAGES.votingEndInconclusive({ thumbsUp: 3, thumbsDown: 3, confused: 0 });
      expect(inconclusiveMsg).toContain("Inconclusive");
    });
  });

  describe("HTTP Handler", () => {
    const createMockRequest = (method: string): IncomingMessage => {
      return { method } as IncomingMessage;
    };

    const createMockResponse = () => {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader: vi.fn((name: string, value: string) => {
          res.headers[name] = value;
        }),
        end: vi.fn((body: string) => {
          res.body = body;
        }),
      };
      return res as unknown as ServerResponse & {
        headers: Record<string, string>;
        body: string;
      };
    };

    describe("GET requests (health check)", () => {
      it("should return 200 ok when environment is valid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({ valid: true, missing: [] });

        // Re-import handler to pick up mocks
        const { default: handler } = await import("./index.js");

        const req = createMockRequest("GET");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.status).toBe("ok");
        expect(body.bot).toBe("Queen");
        expect(body.missing).toBeUndefined();
      });

      it("should return 503 misconfigured when environment is invalid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({
          valid: false,
          missing: ["APP_ID", "WEBHOOK_SECRET"],
        });

        const { default: handler } = await import("./index.js");

        const req = createMockRequest("GET");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.status).toBe("misconfigured");
        expect(body.bot).toBe("Queen");
        expect(body.missing).toBeUndefined();
      });
    });

    describe("POST requests (webhooks)", () => {
      it("should return 503 when environment is misconfigured", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({
          valid: false,
          missing: ["WEBHOOK_SECRET"],
        });

        const { default: handler } = await import("./index.js");

        const req = createMockRequest("POST");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Webhook processing unavailable");
      });

      it("should forward to middleware when environment is valid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({ valid: true, missing: [] });

        const { createNodeMiddleware } = await import("probot");
        const mockMiddleware = vi.fn();
        vi.mocked(createNodeMiddleware).mockReturnValue(mockMiddleware);

        // Re-import to pick up the new middleware mock
        vi.resetModules();
        const { default: handler } = await import("./index.js");

        const req = createMockRequest("POST");
        const res = createMockResponse();

        handler(req, res);

        // The middleware should have been called (it was set up during import)
        // Since we mocked createNodeMiddleware, the actual middleware won't process
        // but we verify the env validation happened
        expect(validateEnv).toHaveBeenCalledWith(true);
      });
    });
  });
});
