/**
 * LLM Types and Schemas
 *
 * Zod schemas for structured LLM output and configuration types.
 * Uses Vercel AI SDK's generateObject() for guaranteed schema compliance.
 */

import { z } from "zod";

// ───────────────────────────────────────────────────────────────────────────────
// Discussion Summary Schema
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Schema for LLM-generated discussion summary.
 * All fields are designed for the voting message format.
 */
export const DiscussionSummarySchema = z.object({
  /**
   * One clear sentence describing what will be built/changed.
   * Should be actionable and specific.
   */
  proposal: z.string().describe(
    "One clear sentence describing what will be built/changed. Be specific and actionable."
  ),

  /**
   * Key points the community agrees on.
   * Empty array if no clear consensus points.
   */
  alignedOn: z.array(z.string()).describe(
    "Key points the community agrees on. Each point should be a concise statement."
  ),

  /**
   * Minor details that can be refined during implementation.
   * These are not blockers but need attention in the PR.
   */
  openForPR: z.array(z.string()).describe(
    "Minor details that can be refined during implementation. Not blockers."
  ),

  /**
   * Ideas explicitly OUT OF SCOPE - will NOT be implemented.
   * These were discussed and rejected. Empty array if nothing was rejected.
   */
  notIncluded: z.array(z.string()).describe(
    "Ideas explicitly OUT OF SCOPE that will NOT be implemented. These were proposed but rejected or ruled out during discussion. Do not implement these."
  ),

  /**
   * Metadata about the discussion for display.
   */
  metadata: z.object({
    commentCount: z.number().describe("Total number of comments analyzed"),
    participantCount: z.number().describe("Number of unique participants"),
  }),
});

export type DiscussionSummary = z.infer<typeof DiscussionSummarySchema>;

// ───────────────────────────────────────────────────────────────────────────────
// LLM Configuration
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Supported LLM providers via Vercel AI SDK.
 */
export type LLMProvider = "openai" | "anthropic" | "google" | "mistral";

/**
 * LLM configuration from environment variables.
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  maxTokens: number;
}

/**
 * Default LLM configuration values.
 */
export const LLM_DEFAULTS = {
  maxTokens: 2000,
  temperature: 0.3,
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// Issue Context for Summarization
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Comment from a discussion participant (not a bot).
 */
export interface DiscussionComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Full issue context for summarization.
 */
export interface IssueContext {
  title: string;
  body: string;
  author: string;
  comments: DiscussionComment[];
}
