import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlueprintGenerator } from "./blueprint.js";
import type { ImplementationPlan, IssueContext } from "./types.js";
import type { Logger } from "../logger.js";

/**
 * Tests for BlueprintGenerator
 *
 * Mirrors summarizer.test.ts structure:
 * - LLM not configured → failure
 * - No discussion from others → minimal blueprint
 * - Successful generation → structured plan
 * - Metadata mismatch → fail closed
 * - LLM API failure → failure with reason
 */

// Mock the AI SDK
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// Mock the provider module
vi.mock("./provider.js", () => ({
  createModelFromEnv: vi.fn(),
}));

describe("BlueprintGenerator", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      group: vi.fn(),
      groupEnd: vi.fn(),
    };
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("when LLM is not configured", () => {
    it("should return failure with reason", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      vi.mocked(createModelFromEnv).mockReturnValue(null);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("LLM not configured");
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "LLM not configured, skipping blueprint generation"
      );
    });
  });

  describe("when there is no meaningful discussion", () => {
    it("should return minimal blueprint when there are no comments", async () => {
      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Add dark mode support");
        expect(result.plan.plan).toBe("");
        expect(result.plan.decisions).toEqual([]);
        expect(result.plan.outOfScope).toEqual([]);
        expect(result.plan.openQuestions).toEqual([]);
        expect(result.plan.metadata.commentCount).toBe(0);
        expect(result.plan.metadata.participantCount).toBe(0);
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "No discussion from others, using minimal blueprint"
      );
    });

    it("should return minimal blueprint when all comments are from issue author", async () => {
      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [
          { author: "alice", body: "Here's more context", createdAt: "2024-01-01T00:00:00Z" },
          { author: "alice", body: "And another update", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Add dark mode support");
        expect(result.plan.metadata.commentCount).toBe(0);
        expect(result.plan.metadata.participantCount).toBe(0);
      }
    });
  });

  describe("when LLM generates a blueprint", () => {
    it("should return the LLM-generated plan", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Implement OAuth 2.0 authentication with GitHub and Google providers",
        plan: "1. Install passport.js\n2. Configure OAuth strategies\n3. Add login routes",
        decisions: ["Use OAuth 2.0", "Support GitHub and Google providers"],
        outOfScope: ["Password-based auth (rejected for security)"],
        openQuestions: ["Exact UI placement TBD"],
        metadata: {
          commentCount: 5,
          participantCount: 3,
        },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockReturnValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add OAuth authentication",
        body: "We need user auth",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Let's use OAuth", createdAt: "2024-01-01T00:00:00Z" },
          { author: "user2", body: "Agreed, no passwords", createdAt: "2024-01-02T00:00:00Z" },
          { author: "user1", body: "Support GitHub", createdAt: "2024-01-03T00:00:00Z" },
          { author: "user3", body: "And Google too", createdAt: "2024-01-04T00:00:00Z" },
          { author: "user2", body: "UI placement can wait", createdAt: "2024-01-05T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Implement OAuth 2.0 authentication with GitHub and Google providers");
        expect(result.plan.decisions).toContain("Use OAuth 2.0");
        expect(result.plan.metadata.commentCount).toBe(5);
        expect(result.plan.metadata.participantCount).toBe(3);
      }
      expect(generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          experimental_repairText: expect.any(Function),
        })
      );
    });

    it("should include author marking and reaction signals in the prompt", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Test",
        plan: "",
        decisions: [],
        outOfScope: [],
        openQuestions: [],
        metadata: { commentCount: 2, participantCount: 2 },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockReturnValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test",
        body: "Body",
        author: "alice",
        comments: [
          { author: "alice", body: "My idea", createdAt: "2024-01-01T00:00:00Z" },
          {
            author: "bob",
            body: "Great idea",
            createdAt: "2024-01-02T00:00:00Z",
            reactions: { thumbsUp: 3, thumbsDown: 0 },
          },
        ],
      };

      await generator.generate(context);

      const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
      const prompt = callArgs.prompt as string;

      // Author marking
      expect(prompt).toContain("@alice (author)");
      // Reaction signal
      expect(prompt).toContain("[👍 3]");
    });

    it("should fail closed when LLM returns incorrect metadata (possible hallucination)", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Test proposal",
        plan: "",
        decisions: [],
        outOfScope: [],
        openQuestions: [],
        metadata: {
          commentCount: 999,
          participantCount: 999,
        },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockReturnValue({
        model: {} as never,
        config: { provider: "openai", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
          { author: "user2", body: "Comment 2", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain("LLM metadata mismatch");
        expect(result.reason).toContain("possible hallucination");
      }
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("LLM metadata mismatch")
      );
    });
  });

  describe("when LLM API fails", () => {
    it("should return failure with error message", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockReturnValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockRejectedValue(new Error("API rate limit exceeded"));

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("API rate limit exceeded");
      }
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Blueprint generation failed: API rate limit exceeded"
      );
    });
  });
});
