import { describe, it, expect } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  describe("recognized mentions", () => {
    it("should parse @queen /vote", () => {
      const result = parseCommand("@queen /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should parse @hivemoot /vote", () => {
      const result = parseCommand("@hivemoot /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should parse @queen /implement", () => {
      const result = parseCommand("@queen /implement");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should parse @hivemoot /implement", () => {
      const result = parseCommand("@hivemoot /implement");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });
  });

  describe("case insensitivity", () => {
    it("should match @Queen /Vote", () => {
      const result = parseCommand("@Queen /Vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should match @HIVEMOOT /IMPLEMENT", () => {
      const result = parseCommand("@HIVEMOOT /IMPLEMENT");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });
  });

  describe("free-text arguments", () => {
    it("should capture free text after verb", () => {
      const result = parseCommand("@queen /implement security fix needs fast-track");
      expect(result).toEqual({ verb: "implement", freeText: "security fix needs fast-track" });
    });

    it("should capture free text with @mentions", () => {
      const result = parseCommand("@hivemoot /implement and co-author with @hivemoot-builder");
      expect(result).toEqual({ verb: "implement", freeText: "and co-author with @hivemoot-builder" });
    });

    it("should trim whitespace from free text", () => {
      const result = parseCommand("@queen /vote   good idea   ");
      expect(result).toEqual({ verb: "vote", freeText: "good idea" });
    });
  });

  describe("command on its own line in larger comment", () => {
    it("should find command on its own line after other text", () => {
      const result = parseCommand("Hey team, I think we should proceed.\n\n@queen /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should find command on indented line", () => {
      const result = parseCommand("Some context:\n  @queen /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should reject command embedded mid-sentence", () => {
      expect(parseCommand("This looks good to me. @hivemoot /implement")).toBeNull();
    });

    it("should reject command embedded in prose", () => {
      expect(parseCommand("Text before @hivemoot /implement")).toBeNull();
    });
  });

  describe("code context handling", () => {
    it("should ignore commands inside inline code", () => {
      expect(parseCommand("Please run `@queen /vote` later")).toBeNull();
    });

    it("should ignore commands inside fenced code blocks", () => {
      const body = "Example:\n```\n@queen /vote\n```\nThat's how you do it.";
      expect(parseCommand(body)).toBeNull();
    });

    it("should ignore commands inside fenced code blocks with language", () => {
      const body = "```bash\n@queen /vote\n```";
      expect(parseCommand(body)).toBeNull();
    });

    it("should still match commands outside code contexts", () => {
      const body = "Here is an example: `@queen /vote`\n@queen /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });
  });

  describe("non-matching inputs", () => {
    it("should return null for empty string", () => {
      expect(parseCommand("")).toBeNull();
    });

    it("should return null for regular comment", () => {
      expect(parseCommand("This is a regular comment")).toBeNull();
    });

    it("should return null for unrecognized mention", () => {
      expect(parseCommand("@someuser /vote")).toBeNull();
    });

    it("should return null for mention without slash command", () => {
      expect(parseCommand("@queen please help")).toBeNull();
    });

    it("should return null for bare slash command without mention", () => {
      expect(parseCommand("/vote")).toBeNull();
    });

    it("should return null for mention without space before slash", () => {
      expect(parseCommand("@queen/vote")).toBeNull();
    });
  });

  describe("whitespace handling", () => {
    it("should handle multiple spaces between mention and command", () => {
      const result = parseCommand("@queen   /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should handle tab between mention and command", () => {
      const result = parseCommand("@queen\t/vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });
  });

  describe("quoted reply handling", () => {
    it("should ignore commands inside GitHub-style quoted replies", () => {
      const body = "> @queen /vote\nI disagree with this";
      expect(parseCommand(body)).toBeNull();
    });

    it("should ignore commands in indented quotes", () => {
      const body = "  > @queen /vote\nI disagree with this";
      expect(parseCommand(body)).toBeNull();
    });

    it("should still match unquoted commands after quoted lines", () => {
      const body = "> @queen /vote\nActually, let me do it.\n@queen /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should ignore multi-line quoted blocks", () => {
      const body = "> @queen /vote\n> More context here\nJust a reply";
      expect(parseCommand(body)).toBeNull();
    });
  });

  describe("multi-command comments", () => {
    it("should only match the first line-start command when multiple are on the same line", () => {
      // Second command is not at line start, so only the first matches
      const body = "@queen /vote @queen /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "vote", freeText: "@queen /implement" });
    });

    it("should match first command when multiple appear on separate lines", () => {
      const body = "@queen /vote\n@queen /implement";
      const result = parseCommand(body);
      expect(result).not.toBeNull();
      expect(result!.verb).toBe("vote");
    });
  });
});
