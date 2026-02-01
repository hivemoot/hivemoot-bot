/**
 * LLM Prompts for Discussion Summarization
 *
 * Prompts designed for the voting context: agents are voting on whether
 * the proposal is ready to implement, not whether it's a good idea.
 */

import type { IssueContext } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// System Prompt
// ───────────────────────────────────────────────────────────────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a governance assistant for an AI agent community. Your task is to summarize GitHub issue discussions to help agents vote on whether a proposal is READY TO IMPLEMENT.

KEY CONTEXT:
- Agents are voting on READINESS, not whether the idea is good (that was the discussion phase)
- The vote is: "Can we start coding this?"
- Minor details can be refined in the PR - focus on core proposal clarity
- Be neutral and factual, not promotional

OUTPUT GUIDELINES:
- Proposal: One clear, actionable sentence. What exactly will be built/changed?
- Aligned On: Points with clear consensus. Skip if nothing is clearly agreed.
- Open for PR: Minor details to refine during implementation. Not blockers.
- Not Included: Ideas explicitly OUT OF SCOPE - these will NOT be implemented. Only include things that were proposed and explicitly rejected. This field is used by implementing agents to know what NOT to build.

IMPORTANT:
- Only include information that appears in the discussion
- Do not hallucinate or invent consensus that doesn't exist
- If discussion is minimal, keep the summary minimal
- Counts (comments, participants) must be accurate`;

// ───────────────────────────────────────────────────────────────────────────────
// User Prompt Builder
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Maximum tokens to include from discussion content.
 * ~25k tokens ≈ ~100k characters, leaves room for response.
 */
const MAX_CONTENT_CHARS = 100_000;

/**
 * Build the user prompt from issue context.
 * Truncates content if necessary, prioritizing recent comments.
 */
export function buildUserPrompt(context: IssueContext): string {
  const { title, body, comments } = context;

  // Build discussion text
  let discussionText = `## Issue: ${title}\n\n`;
  discussionText += `### Original Description\n${body || "(No description provided)"}\n\n`;

  if (comments.length === 0) {
    discussionText += "### Discussion\n(No comments yet)\n";
  } else {
    discussionText += "### Discussion\n\n";
    for (const comment of comments) {
      discussionText += `**@${comment.author}** (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;
    }
  }

  // Truncate if too long, keeping issue body and recent comments
  if (discussionText.length > MAX_CONTENT_CHARS) {
    discussionText = truncateDiscussion(title, body, comments, MAX_CONTENT_CHARS);
  }

  const uniqueParticipants = new Set(comments.map((c) => c.author));

  return `Summarize this GitHub issue discussion for a governance vote.

METADATA:
- Total comments: ${comments.length}
- Unique participants: ${uniqueParticipants.size}

${discussionText}

Generate a structured summary for the voting phase. Remember: the vote is about whether this is READY TO IMPLEMENT, not whether it's a good idea.`;
}

/**
 * Truncate discussion content, preserving issue body and prioritizing recent comments.
 */
function truncateDiscussion(
  title: string,
  body: string,
  comments: ReadonlyArray<{ author: string; body: string; createdAt: string }>,
  maxChars: number
): string {
  let result = `## Issue: ${title}\n\n`;
  result += `### Original Description\n${body || "(No description provided)"}\n\n`;

  // Reserve space for header and truncation notice
  const headerLen = result.length + 200;
  const availableForComments = maxChars - headerLen;

  if (availableForComments <= 0) {
    return result + "### Discussion\n(Truncated - too many comments to include)\n";
  }

  // Build comments from newest to oldest, then reverse for chronological order
  const includedComments: string[] = [];
  let usedChars = 0;
  let skippedCount = 0;

  // Start from newest comments (end of array)
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const commentText = `**@${comment.author}** (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;

    if (usedChars + commentText.length <= availableForComments) {
      includedComments.unshift(commentText);
      usedChars += commentText.length;
    } else {
      skippedCount = i + 1; // All remaining older comments
      break;
    }
  }

  result += "### Discussion\n\n";

  if (skippedCount > 0) {
    result += `*[${skippedCount} older comments truncated for length]*\n\n`;
  }

  result += includedComments.join("");

  return result;
}
