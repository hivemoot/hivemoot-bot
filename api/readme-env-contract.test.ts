import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = new URL("..", import.meta.url);
const SOURCE_DIRECTORIES = ["api", "scripts"] as const;
const EXCLUDED_FILE_SUFFIXES = [".test.ts"] as const;
const EXCLUDED_PATH_SEGMENTS = ["dist", "node_modules"] as const;

function listSourceFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(rootDir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (EXCLUDED_PATH_SEGMENTS.includes(entry)) {
        continue;
      }
      files.push(...listSourceFiles(fullPath));
      continue;
    }

    if (extname(entry) !== ".ts") {
      continue;
    }

    if (EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function isDocumentedRuntimeEnvVar(envVar: string): boolean {
  if (envVar === "APP_ID" || envVar === "PRIVATE_KEY" || envVar === "APP_PRIVATE_KEY" || envVar === "WEBHOOK_SECRET") {
    return true;
  }
  if (envVar.startsWith("HIVEMOOT_")) {
    return true;
  }
  if (envVar.startsWith("LLM_")) {
    return true;
  }
  if (envVar.endsWith("_API_KEY")) {
    return true;
  }
  return false;
}

function getRuntimeEnvVarsFromSource(): Set<string> {
  const envVars = new Set<string>();
  const processEnvPattern = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
  const projectRootPath = fileURLToPath(PROJECT_ROOT);

  for (const sourceDirectory of SOURCE_DIRECTORIES) {
    const rootDir = join(projectRootPath, sourceDirectory);
    for (const sourceFile of listSourceFiles(rootDir)) {
      const content = readFileSync(sourceFile, "utf8");
      for (const match of content.matchAll(processEnvPattern)) {
        const envVar = match[1];
        if (envVar && isDocumentedRuntimeEnvVar(envVar)) {
          envVars.add(envVar);
        }
      }
    }
  }

  return envVars;
}

function getDocumentedEnvVarsFromReadme(readmeContent: string): Set<string> {
  const vars = new Set<string>();
  // Match the first cell of each table row (everything before the second `|`).
  const rowPattern = /^\|([^|]+)\|/gm;
  // Extract every backtick-wrapped ALL_CAPS identifier from the cell.
  const varPattern = /`([A-Z][A-Z0-9_]*)`/g;

  for (const rowMatch of readmeContent.matchAll(rowPattern)) {
    const cell = rowMatch[1];
    if (cell) {
      for (const varMatch of cell.matchAll(varPattern)) {
        const envVar = varMatch[1];
        if (envVar) {
          vars.add(envVar);
        }
      }
    }
  }

  return vars;
}

describe("README environment variable contract", () => {
  it("documents all required runtime environment variables", () => {
    const runtimeEnvVars = getRuntimeEnvVarsFromSource();
    const readme = readFileSync(new URL("README.md", PROJECT_ROOT), "utf8");
    const documentedVars = getDocumentedEnvVarsFromReadme(readme);

    for (const envVar of runtimeEnvVars) {
      expect(documentedVars, `README missing env var: ${envVar}`).toContain(envVar);
    }
  });
});
