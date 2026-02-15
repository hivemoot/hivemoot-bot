import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

function extractRegisteredWebhookEvents(source: string): string[] {
  const callMatches = source.matchAll(/probotApp\.on\(\s*(\[[\s\S]*?\]|["'][^"']+["'])/g);
  const events = new Set<string>();

  for (const [, rawArg] of callMatches) {
    const stringLiterals = rawArg.matchAll(/["']([^"']+)["']/g);
    for (const [, event] of stringLiterals) {
      events.add(event.split(".")[0]);
    }
  }

  return [...events];
}

function extractReadmeWebhookEvents(readmeContents: string): string[] {
  const setupHeading = "## GitHub App Setup";
  const eventsHeading = "Events:";
  const setupStart = readmeContents.indexOf(setupHeading);

  if (setupStart === -1) {
    throw new Error("Could not find '## GitHub App Setup' section in README.md");
  }

  const setupSection = readmeContents.slice(setupStart);
  const eventsStart = setupSection.indexOf(eventsHeading);
  if (eventsStart === -1) {
    throw new Error("Could not find 'Events:' subsection under '## GitHub App Setup' in README.md");
  }

  const eventsSection = setupSection
    .slice(eventsStart + eventsHeading.length)
    .split(/\n##\s+/)[0];

  return eventsSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeEventName(line.slice(2)));
}

describe("README webhook event contract", () => {
  it("documents all required GitHub App webhook subscriptions", () => {
    const readmeContents = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const webhookSource = readFileSync(
      resolve(process.cwd(), "api/github/webhooks/index.ts"),
      "utf8",
    );
    const documentedEvents = extractReadmeWebhookEvents(readmeContents);
    const registeredEvents = extractRegisteredWebhookEvents(webhookSource);

    for (const registeredEvent of registeredEvents) {
      expect(documentedEvents).toContain(registeredEvent);
    }
  });
});
