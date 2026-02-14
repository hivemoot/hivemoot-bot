import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type PackageJson = {
  engines?: {
    node?: string;
  };
};

function readRootFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function getExpectedNodeMajor(): string {
  const packageJson = JSON.parse(readRootFile("package.json")) as PackageJson;
  const enginesNode = packageJson.engines?.node;
  expect(enginesNode).toBeDefined();

  const majorMatch = enginesNode?.match(/(\d+)/);
  expect(majorMatch).not.toBeNull();

  return majorMatch![1];
}

describe("Node version contract", () => {
  it("keeps .nvmrc aligned with package.json engines.node major", () => {
    const expectedMajor = getExpectedNodeMajor();
    const nvmrc = readRootFile(".nvmrc").trim();

    expect(nvmrc).toBe(expectedMajor);
  });

  it("documents nvm usage for local setup", () => {
    const readme = readRootFile("README.md");
    const contributing = readRootFile("CONTRIBUTING.md");

    expect(readme).toContain("nvm use");
    expect(contributing).toContain("nvm use");
    expect(contributing).toContain(".nvmrc");
  });
});
