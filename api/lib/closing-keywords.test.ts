import { describe, expect, it } from "vitest";
import { hasSameRepoClosingKeywordRef } from "./closing-keywords.js";

describe("hasSameRepoClosingKeywordRef", () => {
  const repository = { owner: "hivemoot", repo: "hivemoot-bot" };

  it("matches local issue references", () => {
    expect(hasSameRepoClosingKeywordRef("Fixes #21", repository)).toBe(true);
    expect(hasSameRepoClosingKeywordRef("closes #9.", repository)).toBe(true);
    expect(hasSameRepoClosingKeywordRef("resolves: #12", repository)).toBe(true);
  });

  it("matches fully-qualified same-repo references", () => {
    expect(
      hasSameRepoClosingKeywordRef("Resolves hivemoot/hivemoot-bot#42", repository)
    ).toBe(true);
  });

  it("matches same-repo issue URLs", () => {
    expect(
      hasSameRepoClosingKeywordRef(
        "Fixes https://github.com/hivemoot/hivemoot-bot/issues/123",
        repository
      )
    ).toBe(true);
  });

  it("does not match cross-repo references", () => {
    expect(
      hasSameRepoClosingKeywordRef("Fixes someone/else#21", repository)
    ).toBe(false);
    expect(
      hasSameRepoClosingKeywordRef(
        "Resolves https://github.com/someone/else/issues/33",
        repository
      )
    ).toBe(false);
  });

  it("does not match plain mentions without closing keywords", () => {
    expect(hasSameRepoClosingKeywordRef("Related to #21", repository)).toBe(false);
  });

  it("ignores closing keywords inside inline code", () => {
    expect(
      hasSameRepoClosingKeywordRef("Template example: `Fixes #21`", repository)
    ).toBe(false);
  });

  it("ignores closing keywords inside fenced code blocks", () => {
    expect(
      hasSameRepoClosingKeywordRef(
        "```md\nFixes #21\n```\nThis PR updates docs only.",
        repository
      )
    ).toBe(false);
  });
});
