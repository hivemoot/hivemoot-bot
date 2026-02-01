/**
 * LLM Module
 *
 * Provides LLM-powered summarization for governance voting.
 */

// Types
export type {
  DiscussionSummary,
  DiscussionComment,
  IssueContext,
  LLMConfig,
  LLMProvider,
} from "./types.js";
export { DiscussionSummarySchema, LLM_DEFAULTS } from "./types.js";

// Provider
export { isLLMConfigured, getLLMConfig, createModel, createModelFromEnv } from "./provider.js";

// Summarizer
export { DiscussionSummarizer, formatVotingMessage } from "./summarizer.js";
export type { SummarizationResult, SummarizerConfig } from "./summarizer.js";

// Prompts (exported for testing/debugging purposes)
export { buildUserPrompt, SUMMARIZATION_SYSTEM_PROMPT } from "./prompts.js";
