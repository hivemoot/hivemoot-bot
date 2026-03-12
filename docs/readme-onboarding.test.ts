import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");

describe("README onboarding contract", () => {
  it("front-loads a local quick start with prerequisites", () => {
    expect(readme).toContain("## Quick Start");
    expect(readme).toContain("Node.js 22.x");
    expect(readme).toContain(".nvmrc");
    expect(readme).toContain("otherwise install Node 22.x directly");
    expect(readme).toContain("npm");
    expect(readme).toContain("gh auth status");
  });

  it("documents the copy-paste local verification path", () => {
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm run lint");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("Success signal:");
    expect(readme).toContain("node --version");
  });
});
