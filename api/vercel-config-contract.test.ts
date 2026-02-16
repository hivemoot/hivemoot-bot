import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const VERCEL_JSON_PATH = new URL("../vercel.json", import.meta.url);

interface VercelConfig {
  version: number;
  functions?: {
    [pattern: string]: {
      maxDuration?: number;
    };
  };
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(VERCEL_JSON_PATH, "utf8"));
}

describe("vercel.json configuration contract", () => {
  it("sets explicit maxDuration for serverless functions", () => {
    const config = readVercelConfig();

    expect(config.functions).toBeDefined();
    expect(config.functions).toHaveProperty("api/**/*.ts");

    const apiConfig = config.functions?.["api/**/*.ts"];
    expect(apiConfig).toBeDefined();
    expect(apiConfig?.maxDuration).toBe(60);
  });

  it("maxDuration matches Vercel Pro tier limit to prevent silent timeouts", () => {
    const config = readVercelConfig();
    const maxDuration = config.functions?.["api/**/*.ts"]?.maxDuration;

    // Vercel Pro tier supports up to 60s
    // Hobby tier only supports 10s
    // This config documents our deployment assumption: Pro tier or higher
    expect(maxDuration).toBe(60);
    expect(maxDuration).toBeGreaterThan(10); // Would fail on Hobby tier
    expect(maxDuration).toBeLessThanOrEqual(60); // Max for Pro without Fluid Compute
  });
});
