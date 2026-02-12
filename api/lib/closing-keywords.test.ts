import { describe, it, expect } from "vitest";
import { hasClosingKeywordForRepo } from "./closing-keywords.js";

describe("hasClosingKeywordForRepo", () => {
  const owner = "hivemoot";
  const repo = "hivemoot-bot";

  it("matches local issue references with closing keywords", () => {
    expect(hasClosingKeywordForRepo("Fixes #16", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("closes: #42", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("resolved #7", owner, repo)).toBe(true);
  });

  it("matches same-repo explicit owner/repo references", () => {
    expect(hasClosingKeywordForRepo("Resolves hivemoot/hivemoot-bot#16", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("fixes HIVEMOOT/HIVEMOOT-BOT#16", owner, repo)).toBe(true);
  });

  it("matches same-repo issue URL references", () => {
    expect(
      hasClosingKeywordForRepo(
        "Closes https://github.com/hivemoot/hivemoot-bot/issues/16",
        owner,
        repo
      )
    ).toBe(true);
  });

  it("ignores references for other repositories", () => {
    expect(hasClosingKeywordForRepo("Fixes someone/else#16", owner, repo)).toBe(false);
    expect(
      hasClosingKeywordForRepo(
        "Resolves https://github.com/someone/else/issues/16",
        owner,
        repo
      )
    ).toBe(false);
  });

  it("matches when at least one same-repo reference is present", () => {
    const body = "Fixes someone/else#11\nResolves hivemoot/hivemoot-bot#16";
    expect(hasClosingKeywordForRepo(body, owner, repo)).toBe(true);
  });

  it("ignores non-closing references", () => {
    expect(hasClosingKeywordForRepo("related to #16", owner, repo)).toBe(false);
    expect(hasClosingKeywordForRepo("see hivemoot/hivemoot-bot#16", owner, repo)).toBe(false);
  });

  it("returns false for empty body", () => {
    expect(hasClosingKeywordForRepo(undefined, owner, repo)).toBe(false);
    expect(hasClosingKeywordForRepo(null, owner, repo)).toBe(false);
    expect(hasClosingKeywordForRepo("", owner, repo)).toBe(false);
  });
});
