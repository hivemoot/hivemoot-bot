import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "installation",
  "installation_repositories",
  "pull_request",
  "pull_request_review",
  "check_suite",
  "check_run",
  "status",
] as const;

const EVENT_NAME_MAP: Record<string, string> = {
  issues: "issues",
  "issue comment": "issue_comment",
  "issue comments": "issue_comment",
  installation: "installation",
  "installation repository": "installation_repositories",
  "installation repositories": "installation_repositories",
  "pull request": "pull_request",
  "pull requests": "pull_request",
  "pull request review": "pull_request_review",
  "pull request reviews": "pull_request_review",
  "check suite": "check_suite",
  "check suites": "check_suite",
  "check run": "check_run",
  "check runs": "check_run",
  "commit status": "status",
  "commit statuses": "status",
  status: "status",
  statuses: "status",
};

function normalizeEventName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return EVENT_NAME_MAP[normalized] ?? normalized;
}

function extractReadmeWebhookEvents(readmeContents: string): string[] {
  const sectionMatch = readmeContents.match(
    /## GitHub App Setup[\s\S]*?Events:\n\n([\s\S]*?)(?:\n## |\n$)/
  );

  if (!sectionMatch) {
    throw new Error("Could not find 'GitHub App Setup > Events' section in README.md");
  }

  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeEventName(line.slice(2)));
}

describe("README webhook event contract", () => {
  it("documents all required GitHub App webhook subscriptions", () => {
    const readmeContents = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const documentedEvents = extractReadmeWebhookEvents(readmeContents);

    for (const requiredEvent of REQUIRED_WEBHOOK_EVENTS) {
      expect(documentedEvents).toContain(requiredEvent);
    }
  });
});
