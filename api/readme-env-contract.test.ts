import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const REQUIRED_ENV_VARS = [
  "APP_ID",
  "PRIVATE_KEY",
  "APP_PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "NODEJS_HELPERS",
  "HIVEMOOT_DISCUSSION_DURATION_MINUTES",
  "HIVEMOOT_VOTING_DURATION_MINUTES",
  "HIVEMOOT_PR_STALE_DAYS",
  "HIVEMOOT_MAX_PRS_PER_ISSUE",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
] as const;

function getDocumentedEnvVarsFromReadme(readmeContent: string): Set<string> {
  const vars = new Set<string>();
  const rowPattern = /^\|\s*`([A-Z0-9_]+)`\s*\|/gm;

  for (const match of readmeContent.matchAll(rowPattern)) {
    const envVar = match[1];
    if (envVar) {
      vars.add(envVar);
    }
  }

  return vars;
}

describe("README environment variable contract", () => {
  it("documents all required runtime environment variables", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const documentedVars = getDocumentedEnvVarsFromReadme(readme);

    for (const envVar of REQUIRED_ENV_VARS) {
      expect(documentedVars, `README missing env var: ${envVar}`).toContain(envVar);
    }
  });
});
