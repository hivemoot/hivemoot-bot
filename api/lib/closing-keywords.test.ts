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

  it("ignores closing keywords inside fenced code blocks", () => {
    const body = "```md\nFixes #21\n```\nThis PR updates docs only.";
    expect(hasClosingKeywordForRepo(body, owner, repo)).toBe(false);
  });

  it("ignores closing keywords inside inline code", () => {
    const body = "Use `Fixes #21` syntax to link PRs.";
    expect(hasClosingKeywordForRepo(body, owner, repo)).toBe(false);
  });

  it("matches closing keywords outside code when code also present", () => {
    const body = "```\nFixes #99\n```\nFixes #21";
    expect(hasClosingKeywordForRepo(body, owner, repo)).toBe(true);
  });

  it("ignores closing keywords inside multi-line fenced code blocks", () => {
    const body = "```yaml\nversion: 1\n# Fixes #21\ngovernance: {}\n```\nNo linked issue here.";
    expect(hasClosingKeywordForRepo(body, owner, repo)).toBe(false);
  });

  it("matches all closing keyword variants", () => {
    expect(hasClosingKeywordForRepo("close #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("closed #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("closes #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("fix #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("fixed #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("fixes #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("resolve #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("resolved #1", owner, repo)).toBe(true);
    expect(hasClosingKeywordForRepo("resolves #1", owner, repo)).toBe(true);
  });
});
