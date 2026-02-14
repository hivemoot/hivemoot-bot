import { generateObject } from "ai";
import { z } from "zod";

import type { LanguageModelV1 } from "ai";

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { createModelFromEnv } from "./provider.js";
import { withLLMRetry } from "./retry.js";
import type { LLMConfig } from "./types.js";
import { LLM_DEFAULTS } from "./types.js";

const CommitMessageSuggestionSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(72)
    .describe("Imperative subject line, max 72 chars"),
  body: z
    .string()
    .min(1)
    .describe("Short body explaining why and key changes, 1-3 paragraphs"),
});

export interface CommitMessageContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  linkedIssuesHint: string;
  commitHeadlines: string[];
}

export interface CommitMessageSuggestion {
  subject: string;
  body: string;
}

export type CommitMessageResult =
  | { success: true; suggestion: CommitMessageSuggestion }
  | { success: false; reason: string };

export interface CommitMessageGeneratorConfig {
  logger?: Logger;
}

const SYSTEM_PROMPT = [
  "You are writing a squash-merge commit message for a production repository.",
  "Return JSON only through the schema.",
  "Subject must be imperative, clear, and 72 characters or fewer.",
  "Body must explain why this change exists and summarize key implementation details.",
  "Do not include markdown fences or bullet lists unless strictly necessary.",
  "Do not invent details not present in the provided context.",
].join("\n");

function buildPrompt(context: CommitMessageContext): string {
  const commitLines = context.commitHeadlines.length > 0
    ? context.commitHeadlines.map((line) => `- ${line}`).join("\n")
    : "- (none)";

  return [
    `PR #${context.prNumber}`,
    `PR title: ${context.prTitle || "(empty)"}`,
    "PR body:",
    context.prBody || "(empty)",
    `Linked issues hint: ${context.linkedIssuesHint}`,
    "Existing commit headlines:",
    commitLines,
    "",
    "Generate a commit message suggestion suitable for squash merge.",
  ].join("\n");
}

export class CommitMessageGenerator {
  private logger: Logger;

  constructor(config?: CommitMessageGeneratorConfig) {
    this.logger = config?.logger ?? defaultLogger;
  }

  async generate(
    context: CommitMessageContext,
    preCreatedModel?: { model: LanguageModelV1; config: LLMConfig }
  ): Promise<CommitMessageResult> {
    try {
      const modelResult = preCreatedModel ?? createModelFromEnv();
      if (!modelResult) {
        return { success: false, reason: "LLM not configured" };
      }

      const { model, config } = modelResult;
      const response = await withLLMRetry(
        () => generateObject({
          model,
          schema: CommitMessageSuggestionSchema,
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(context),
          maxTokens: config.maxTokens,
          temperature: LLM_DEFAULTS.temperature,
          maxRetries: 0,
        }),
        undefined,
        this.logger,
      );

      return { success: true, suggestion: response.object };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Commit message generation failed: ${message}`);
      return { success: false, reason: message };
    }
  }
}
