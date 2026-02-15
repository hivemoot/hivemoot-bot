/**
 * Local LLM Debug Script
 *
 * Tests generateObject with different Gemini models and configurations
 * to identify why "No object generated" errors occur in production.
 *
 * Usage:
 *   GOOGLE_API_KEY=... npx tsx scripts/test-llm.ts
 *
 * Or set LLM_PROVIDER/LLM_MODEL/GOOGLE_API_KEY in env.
 */

import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("GOOGLE_API_KEY is required");
  process.exit(1);
}

const google = createGoogleGenerativeAI({ apiKey });

// Simple test schema (same as CommitMessageSchema)
const simpleSchema = z.object({
  subject: z.string().describe("Short imperative subject line"),
  body: z.string().describe("1-2 sentences explaining WHY"),
});

// The prompt that mirrors what commit-message.ts sends
const testPrompt = `Generate a squash commit message for PR #100.

## PR Title
Add health check endpoint

## PR Description
Adds LLM readiness to the health check response so we can verify configuration after deployment.

## Files Changed
api/github/webhooks/index.ts | 5 ++
api/lib/llm/provider.ts      | 2 ++

## Commits (2)
- Add isLLMConfigured to health response
- Add tests for health endpoint`;

const systemPrompt = `You are a commit message generator. Generate a concise commit message.
SUBJECT LINE RULES: Use imperative mood, max 72 characters, no trailing period.
BODY RULES: 1-3 sentences explaining WHY.`;

interface TestConfig {
  name: string;
  model: string;
  structuredOutputs?: boolean;
}

const tests: TestConfig[] = [
  // Test 1: The production config (gemini-3-flash-preview, default structuredOutputs=true)
  { name: "gemini-3-flash-preview (default)", model: "gemini-3-flash-preview" },
  // Test 2: Same model, structuredOutputs disabled
  { name: "gemini-3-flash-preview (no structured)", model: "gemini-3-flash-preview", structuredOutputs: false },
  // Test 3: Older stable model
  { name: "gemini-2.0-flash (default)", model: "gemini-2.0-flash" },
  // Test 4: Older model, structuredOutputs disabled
  { name: "gemini-2.0-flash (no structured)", model: "gemini-2.0-flash", structuredOutputs: false },
];

async function runTest(config: TestConfig): Promise<void> {
  const label = `[${config.name}]`;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${label} Testing...`);

  try {
    const model = google(config.model);
    const providerOptions =
      config.structuredOutputs === false ? { google: { structuredOutputs: false } } : undefined;

    const result = await generateObject({
      model,
      schema: simpleSchema,
      system: systemPrompt,
      prompt: testPrompt,
      maxTokens: 500,
      temperature: 0.3,
      maxRetries: 0,
      ...(providerOptions ? { providerOptions } : {}),
    });

    console.log(`${label} SUCCESS`);
    console.log(`  subject: "${result.object.subject}"`);
    console.log(`  body: "${result.object.body}"`);
    console.log(`  usage: ${JSON.stringify(result.usage)}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${label} FAILED: ${msg}`);
    if (error instanceof Error && error.cause) {
      console.error(`  cause: ${JSON.stringify(error.cause)}`);
    }
  }
}

async function main() {
  console.log("LLM Debug: Testing generateObject with Gemini models");
  try {
    const { version } = JSON.parse(
      (await import("fs")).readFileSync(
        new URL("../../node_modules/@ai-sdk/google/package.json", import.meta.url),
        "utf8"
      )
    );
    console.log(`@ai-sdk/google version: ${version}`);
  } catch {
    console.log("@ai-sdk/google version: unknown");
  }

  for (const test of tests) {
    await runTest(test);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("Done.");
}

main().catch(console.error);
