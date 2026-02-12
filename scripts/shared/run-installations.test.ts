import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runIfMain } from "./run-installations.js";

const ORIGINAL_ARGV = [...process.argv];

describe("runIfMain", () => {
  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
  });

  it("runs main when argv[1] is an absolute path to the caller", async () => {
    const callerPath = resolve("scripts/close-discussions.ts");
    const callerUrl = pathToFileURL(callerPath).href;
    const main = vi.fn().mockResolvedValue(undefined);

    process.argv = ["node", callerPath];
    runIfMain(callerUrl, main);
    await Promise.resolve();

    expect(main).toHaveBeenCalledTimes(1);
  });

  it("runs main when argv[1] is a relative path to the caller", async () => {
    const callerPath = resolve("scripts/close-discussions.ts");
    const callerUrl = pathToFileURL(callerPath).href;
    const main = vi.fn().mockResolvedValue(undefined);

    process.argv = ["node", "scripts/close-discussions.ts"];
    runIfMain(callerUrl, main);
    await Promise.resolve();

    expect(main).toHaveBeenCalledTimes(1);
  });

  it("does not run main when caller does not match argv[1]", async () => {
    const callerUrl = pathToFileURL(resolve("scripts/cleanup-stale-prs.ts")).href;
    const main = vi.fn().mockResolvedValue(undefined);

    process.argv = ["node", "scripts/close-discussions.ts"];
    runIfMain(callerUrl, main);
    await Promise.resolve();

    expect(main).not.toHaveBeenCalled();
  });
});
