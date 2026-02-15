import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRoot(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function extractH2Section(content: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionMatch = content.match(
    new RegExp(`^## ${escapedHeading}\\n([\\s\\S]*?)(?=^## |\\Z)`, "m"),
  );
  if (!sectionMatch) {
    throw new Error(`Could not extract section for heading '${heading}'`);
  }
  return sectionMatch[1];
}

function extractBulletList(section: string, listHeading: string): string[] {
  const lines = section.split("\n");
  const headingLine = lines.findIndex((line) => line.trim() === listHeading);
  if (headingLine === -1) {
    throw new Error(`Missing list heading '${listHeading}'`);
  }

  const items: string[] = [];
  let listStarted = false;

  for (const line of lines.slice(headingLine + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      listStarted = true;
      items.push(trimmed.slice(2));
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    if (listStarted) {
      break;
    }
  }

  return items;
}

describe("README GitHub App setup contract", () => {
  const readme = readRoot("README.md");
  const githubAppSetup = extractH2Section(readme, "GitHub App Setup");

  it("documents all required app permissions", () => {
    const permissions = extractBulletList(githubAppSetup, "Permissions:");
    const requiredPermissions = [
      "Issues: Read & Write",
      "Pull Requests: Read & Write",
      "Metadata: Read",
      "Discussions: Read & Write (required for daily standup discussions)",
      "Checks: Read (required for merge-readiness evaluation)",
      "Commit statuses: Read (required for legacy status-based CI integration)",
    ];

    expect(permissions).toEqual(expect.arrayContaining(requiredPermissions));
    expect(permissions).toHaveLength(requiredPermissions.length);
  });

  it("documents all required webhook event subscriptions", () => {
    const events = extractBulletList(githubAppSetup, "Events:");
    const requiredEvents = [
      "Issues (includes labeled/unlabeled actions)",
      "Issue comments",
      "Installation",
      "Installation repositories",
      "Pull requests",
      "Pull request reviews",
      "Check suites",
      "Check runs",
      "Statuses",
    ];

    expect(events).toEqual(expect.arrayContaining(requiredEvents));
    expect(events).toHaveLength(requiredEvents.length);
  });
});
