import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernanceService } from "../../lib/governance.js";
import { createIssueOperations } from "../../lib/github-client.js";
import { LABELS, MESSAGES, REQUIRED_REPOSITORY_LABELS } from "../../config.js";
import type { IssueRef } from "../../lib/types.js";
import type { IncomingMessage, ServerResponse } from "http";
import { app as registerWebhookApp } from "./index.js";

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

/**
 * Tests for Queen Bot webhook handlers
 *
 * These tests verify:
 * 1. GovernanceService integration for issue handling
 * 2. Health check endpoint behavior with configuration validation
 * 3. Error handling propagation
 */

const TEST_APP_ID = 12345;

type WebhookHandler = (context: unknown) => Promise<void> | void;

function buildIterator<T>(pages: T[][]): AsyncIterable<{ data: T[] }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
}

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const entry of event) {
          handlers.set(entry, handler);
        }
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

function createInstallationOctokit(options?: {
  existingLabels?: Array<{ name: string }>;
  fallbackRepositories?: Array<{ name: string; full_name: string; owner?: { login?: string } | null }>;
  fallbackRepositoryPages?: Array<Array<{ name: string; full_name: string; owner?: { login?: string } | null }>>;
  createLabelImpl?: (params: {
    owner: string;
    repo: string;
    name: string;
    color: string;
    description?: string;
  }) => Promise<unknown>;
}) {
  const existingLabels = options?.existingLabels ?? [];
  const fallbackRepositories = options?.fallbackRepositories ?? [];
  const fallbackRepositoryPages = options?.fallbackRepositoryPages ?? [fallbackRepositories];
  const createLabelImpl = options?.createLabelImpl ?? (async () => ({}));

  const rest = {
    issues: {
      listLabelsForRepo: vi.fn(),
      createLabel: vi.fn().mockImplementation(createLabelImpl),
    },
    apps: {
      listReposAccessibleToInstallation: vi.fn().mockImplementation(async ({ page = 1 }: {
        per_page?: number;
        page?: number;
      }) => ({
        data: {
          repositories: fallbackRepositoryPages[page - 1] ?? [],
        },
      })),
    },
  };

  return {
    rest,
    paginate: {
      iterator: vi.fn().mockImplementation((method: unknown) => {
        if (method === rest.issues.listLabelsForRepo) {
          return buildIterator([existingLabels]);
        }
        return buildIterator([[]]);
      }),
    },
  };
}

describe("Queen Bot", () => {
  describe("Installation label bootstrap handlers", () => {
    it("should bootstrap labels from installation.created payload repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const octokit = createInstallationOctokit();
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };
      await handler!({
        octokit,
        log,
        payload: {
          repositories: [
            {
              owner: { login: "hivemoot" },
              name: "repo-a",
              full_name: "hivemoot/repo-a",
            },
          ],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "repo-a",
        })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsSkipped=0`
      );
    });

    it("should bootstrap labels from installation_repositories.added payload repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation_repositories.added");
      expect(handler).toBeDefined();

      const octokit = createInstallationOctokit();
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };
      await handler!({
        octokit,
        log,
        payload: {
          repositories_added: [
            {
              name: "repo-b",
              full_name: "hivemoot/repo-b",
            },
          ],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "repo-b",
        })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation_repositories.added] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsSkipped=0`
      );
    });

    it("should fetch installation repositories when installation.created payload omits repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const fallbackRepositories = [
        { name: "repo-c", full_name: "hivemoot/repo-c" },
        { name: "repo-d", full_name: "hivemoot/repo-d" },
      ];
      const octokit = createInstallationOctokit({ fallbackRepositories });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {},
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-c" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-d" })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length}, labelsSkipped=0`
      );
    });

    it("should paginate installation repository fallback listing beyond first page", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const pageOneRepositories = Array.from({ length: 100 }, (_, index) => ({
        name: `repo-${index + 1}`,
        full_name: `hivemoot/repo-${index + 1}`,
      }));
      const pageTwoRepositories = [{ name: "repo-101", full_name: "hivemoot/repo-101" }];
      const octokit = createInstallationOctokit({
        fallbackRepositoryPages: [pageOneRepositories, pageTwoRepositories],
      });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {},
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(1, {
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(2, {
        per_page: 100,
        page: 2,
      });
      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-1" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-101" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * 101
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=101, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * 101}, labelsSkipped=0`
      );
    });

    it("should fetch installation repositories when installation_repositories.added payload is empty", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation_repositories.added");
      expect(handler).toBeDefined();

      const fallbackRepositories = [{ name: "repo-e", full_name: "hivemoot/repo-e" }];
      const octokit = createInstallationOctokit({ fallbackRepositories });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {
          repositories_added: [],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-e" })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation_repositories.added] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsSkipped=0`
      );
    });

    it("should log summary counters and fail when one repository bootstrap fails", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const repositories = [
        { name: "repo-ok", full_name: "hivemoot/repo-ok" },
        { name: "repo-fail", full_name: "hivemoot/repo-fail" },
      ];
      const octokit = createInstallationOctokit({
        createLabelImpl: async (params) => {
          if (params.repo === "repo-fail") {
            throw new Error("boom");
          }
          return {};
        },
      });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await expect(
        handler!({
          octokit,
          log,
          payload: {
            repositories,
          },
        })
      ).rejects.toThrow("1 repository label bootstrap operation(s) failed");

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=1, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsSkipped=0`
      );
    });
  });

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
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
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

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("hivemoot-metadata:");
      expect(commentBody).toContain('"type":"welcome"');
      expect(commentBody).toContain("Discussion Phase");
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
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
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

    it("should post no-linked-issue comment on unlinked PR", async () => {
      const mockOctokit = createMockOctokit();
      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };
      await issues.comment(ref, MESSAGES.PR_NO_LINKED_ISSUE);

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 123,
        body: MESSAGES.PR_NO_LINKED_ISSUE,
      });
    });

    it("should propagate API errors", async () => {
      const mockOctokit = createMockOctokit();
      const apiError = new Error("Permission denied");
      mockOctokit.rest.issues.createComment.mockRejectedValue(apiError);

      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };

      await expect(issues.comment(ref, MESSAGES.PR_NO_LINKED_ISSUE)).rejects.toThrow("Permission denied");
    });
  });

  describe("issues.labeled Handler (manual voting transition)", () => {
    /** Build a valid mock Octokit that passes createIssueOperations validation */
    const createLabeledMockOctokit = (overrides?: {
      comments?: Array<{ id: number; body: string; performed_via_github_app?: { id: number } | null }>;
    }) => {
      const comments = overrides?.comments ?? [];
      return {
        rest: {
          issues: {
            get: vi.fn().mockResolvedValue({ data: {} }),
            addLabels: vi.fn().mockResolvedValue({}),
            removeLabel: vi.fn().mockResolvedValue({}),
            createComment: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
            lock: vi.fn().mockResolvedValue({}),
            unlock: vi.fn().mockResolvedValue({}),
            listComments: vi.fn(),
          },
          reactions: {
            listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
            listForIssue: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        paginate: {
          // Each call gets a fresh generator (generators are single-use)
          iterator: vi.fn().mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
              yield { data: comments };
            },
          })),
        },
      };
    };

    it("should register the issues.labeled handler", () => {
      const { handlers } = createWebhookHarness();
      expect(handlers.get("issues.labeled")).toBeDefined();
    });

    it("should skip non-voting labels", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();

      await handler({
        payload: {
          label: { name: "bug" },
          issue: { number: 42 },
          sender: { type: "User", login: "alice" },
          repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log: { info: vi.fn(), error: vi.fn() },
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should skip Bot senders (automatic transitions)", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 42 },
          sender: { type: "Bot", login: "hivemoot-bot[bot]" },
          repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log: { info: vi.fn(), error: vi.fn() },
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should post voting comment for manual user label addition", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      // No existing comments → findVotingCommentId returns null → posts new comment
      const mockOctokit = createLabeledMockOctokit();
      const log = { info: vi.fn(), error: vi.fn() };

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 26 },
          sender: { type: "User", login: "hivemoot" },
          repository: { name: "sandbox", full_name: "hivemoot/sandbox", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log,
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain('"type":"voting"');
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Voting comment for issue #26: posted"),
      );
    });

    it("should skip when voting comment already exists", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const existingVotingComment = {
        id: 999,
        body: `<!-- hivemoot-metadata: ${JSON.stringify({ version: 1, type: "voting", issueNumber: 26, cycle: 1 })} -->\nVoting stuff`,
        performed_via_github_app: { id: TEST_APP_ID },
      };
      const mockOctokit = createLabeledMockOctokit({ comments: [existingVotingComment] });
      const log = { info: vi.fn(), error: vi.fn() };

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 26 },
          sender: { type: "User", login: "hivemoot" },
          repository: { name: "sandbox", full_name: "hivemoot/sandbox", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log,
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Voting comment for issue #26: skipped"),
      );
    });

    it("should propagate errors from postVotingComment", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();
      // Force createComment to fail
      mockOctokit.rest.issues.createComment.mockRejectedValue(new Error("API failure"));
      const log = { info: vi.fn(), error: vi.fn() };

      await expect(
        handler({
          payload: {
            label: { name: LABELS.VOTING },
            issue: { number: 42 },
            sender: { type: "User", login: "alice" },
            repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
          },
          octokit: mockOctokit,
          log,
        }),
      ).rejects.toThrow("API failure");

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ issue: 42 }),
        expect.stringContaining("Failed to post voting comment"),
      );
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
      expect(MESSAGES.ISSUE_WELCOME_VOTING).toContain("Queen");
      expect(MESSAGES.ISSUE_WELCOME).toContain("Queen");
      expect(MESSAGES.ISSUE_WELCOME_MANUAL).toContain("Queen");
      expect(MESSAGES.PR_NO_LINKED_ISSUE).toContain("Queen");
      expect(MESSAGES.VOTING_START).toContain("Queen");
    });

    it("should keep distinct issue welcome text for vote and manual modes", () => {
      expect(MESSAGES.ISSUE_WELCOME_VOTING).toContain("Ready to vote?");
      expect(MESSAGES.ISSUE_WELCOME_MANUAL).toContain("Nothing moves forward automatically here.");
    });

    it("should include voting instructions in VOTING_START", () => {
      expect(MESSAGES.VOTING_START).toContain("React to THIS comment to vote");
      expect(MESSAGES.VOTING_START).toContain("👍");
      expect(MESSAGES.VOTING_START).toContain("👎");
    });

    it("should format vote results correctly", () => {
      const votes = { thumbsUp: 5, thumbsDown: 2, confused: 1, eyes: 0 };

      const readyMsg = MESSAGES.votingEndReadyToImplement(votes);
      expect(readyMsg).toContain("👍 5");
      expect(readyMsg).toContain("👎 2");
      expect(readyMsg).toContain("😕 1");
      expect(readyMsg).toContain("Ready to Implement");

      const rejectedMsg = MESSAGES.votingEndRejected(votes);
      expect(rejectedMsg).toContain("Rejected");

      const inconclusiveMsg = MESSAGES.votingEndInconclusive({ thumbsUp: 3, thumbsDown: 3, confused: 0, eyes: 0 });
      expect(inconclusiveMsg).toContain("Extended Voting");
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
