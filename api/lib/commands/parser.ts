/**
 * Command Parser
 *
 * Parses @mention + /command patterns from issue/PR comment bodies.
 * Supports hardcoded mention names: @queen and @hivemoot.
 *
 * Examples:
 *   "@queen /vote"           → { verb: "vote", freeText: undefined }
 *   "@hivemoot /implement"   → { verb: "implement", freeText: undefined }
 *   "@queen /vote good idea" → { verb: "vote", freeText: "good idea" }
 */

/**
 * Parsed command extracted from a comment body.
 */
export interface ParsedCommand {
  /** The command verb (e.g., "vote", "implement") */
  verb: string;
  /** Optional free-text argument following the verb */
  freeText: string | undefined;
}

/**
 * Hardcoded mention names the bot responds to.
 * Per issue #81: "we will hardcode support to @queen and @hivemoot"
 */
const MENTION_NAMES = ["queen", "hivemoot"] as const;

/**
 * Regex pattern to match @mention + /command.
 *
 * Matches: @queen /verb [optional free text]
 *          @hivemoot /verb [optional free text]
 *
 * The pattern is case-insensitive and allows whitespace between mention and command.
 */
const COMMAND_PATTERN = new RegExp(
  `@(?:${MENTION_NAMES.join("|")})\\s+/(\\w+)(?:\\s+(.+))?`,
  "i",
);

function stripQuotedLines(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/**
 * Parse a comment body for a bot command.
 *
 * Returns the parsed command if found, or null if the comment
 * does not contain a recognized @mention + /command pattern.
 */
export function parseCommand(body: string): ParsedCommand | null {
  const match = stripQuotedLines(body).match(COMMAND_PATTERN);
  if (!match) {
    return null;
  }

  const verb = match[1].toLowerCase();
  const freeText = match[2]?.trim() || undefined;

  return { verb, freeText };
}
