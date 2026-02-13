#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function getRequiredNodeMajor() {
  const packageJsonPath = path.resolve(process.cwd(), "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const nodeRange = packageJson?.engines?.node;

  if (typeof nodeRange !== "string") {
    return null;
  }

  const majorMatch = nodeRange.match(/(\d+)/);
  return majorMatch ? Number(majorMatch[1]) : null;
}

const requiredMajor = getRequiredNodeMajor();
const currentMajor = Number(process.versions.node.split(".")[0]);

if (requiredMajor === null || Number.isNaN(requiredMajor)) {
  process.exit(0);
}

if (currentMajor !== requiredMajor) {
  console.error(
    [
      `Unsupported Node.js version: ${process.versions.node}`,
      `Required major version: ${requiredMajor}.x (from package.json engines.node)`,
      "Run `nvm use` (or install Node 20.x) and retry."
    ].join("\n")
  );
  process.exit(1);
}
