import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRoot(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function extractSection(content: string, heading: string, nextHeading: string): string {
  const start = content.indexOf(heading);
  const end = content.indexOf(nextHeading);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract section between '${heading}' and '${nextHeading}'`);
  }
  return content.slice(start, end);
}

function extractListItems(section: string, listHeading: string): string[] {
  const headingIndex = section.indexOf(listHeading);
  if (headingIndex === -1) {
    throw new Error(`Missing list heading '${listHeading}'`);
  }
  const afterHeading = section.slice(headingIndex + listHeading.length);
  const listBlock = afterHeading.split("\n\n")[1] ?? "";
  return listBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

describe("README GitHub App setup contract", () => {
  const readme = readRoot("README.md");
  const githubAppSetup = extractSection(readme, "## GitHub App Setup", "## Local Development");

  it("documents all required app permissions", () => {
    const permissions = extractListItems(githubAppSetup, "Permissions:");

    expect(permissions).toEqual([
      "Issues: Read & Write",
      "Pull Requests: Read & Write",
      "Metadata: Read",
      "Discussions: Read & Write (required for daily standup discussions)",
      "Checks: Read (required for merge-readiness evaluation)",
      "Commit statuses: Read (required for legacy status-based CI integration)",
    ]);
  });

  it("documents all required webhook event subscriptions", () => {
    const events = extractListItems(githubAppSetup, "Events:");

    expect(events).toEqual([
      "Issues (includes labeled/unlabeled actions)",
      "Issue comments",
      "Installation",
      "Installation repositories",
      "Pull requests",
      "Pull request reviews",
      "Check suites",
      "Check runs",
      "Statuses",
    ]);
  });
});
