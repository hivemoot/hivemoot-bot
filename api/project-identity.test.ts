import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("project identity contract", () => {
  it("keeps package description aligned with repository identity", () => {
    const packageJsonRaw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const packageJson = JSON.parse(packageJsonRaw) as { description?: string };

    expect(packageJson.description).toContain("Hivemoot Bot");
  });

  it("keeps workflows doc title aligned with repository identity", () => {
    const workflowsDoc = readFileSync(join(process.cwd(), "docs", "WORKFLOWS.md"), "utf8");

    expect(workflowsDoc).toMatch(/^# Hivemoot Bot Workflows$/m);
  });
});
