import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { getAppConfig } from "../../api/lib/env-validation.js";
import { logger } from "../../api/lib/index.js";
import { App } from "octokit";
import { runForAllRepositories, runIfMain } from "./run-installations.js";

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
}));

vi.mock("../../api/lib/env-validation.js", () => ({
  getAppConfig: vi.fn(),
}));

vi.mock("../../api/lib/index.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

// Suppress unhandled rejection from runIfMain().catch() calling process.exit(1).
process.on("unhandledRejection", () => {});

describe("run-installations", () => {
  const mockSetFailed = vi.mocked(core.setFailed);
  const mockGetAppConfig = vi.mocked(getAppConfig);
  const mockApp = vi.mocked(App);
  const mockExit = vi.spyOn(process, "exit");

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppConfig.mockReturnValue({
      appId: 123,
      privateKey: "test-key",
      webhookSecret: "secret",
      nodejsHelpers: false,
      discussionDurationMinutes: 1440,
      votingDurationMinutes: 1440,
      prStaleDays: 3,
      maxPRsPerIssue: 3,
    });
    mockExit.mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
  });

  it("reports aggregated results and no failures when all repositories succeed", async () => {
    const installationOneOctokit = {
      paginate: vi.fn().mockResolvedValue([
        { owner: { login: "org" }, name: "alpha", full_name: "org/alpha" },
      ]),
      rest: { apps: { listReposAccessibleToInstallation: vi.fn() } },
    };
    const installationTwoOctokit = {
      paginate: vi.fn().mockResolvedValue([
        { owner: { login: "org" }, name: "beta", full_name: "org/beta" },
      ]),
      rest: { apps: { listReposAccessibleToInstallation: vi.fn() } },
    };
    const appInstance = {
      octokit: {
        paginate: vi.fn().mockResolvedValue([
          { id: 1, account: { login: "inst-one" } },
          { id: 2, account: { login: "inst-two" } },
        ]),
        rest: { apps: { listInstallations: vi.fn() } },
      },
      getInstallationOctokit: vi
        .fn()
        .mockResolvedValueOnce(installationOneOctokit)
        .mockResolvedValueOnce(installationTwoOctokit),
    };
    mockApp.mockImplementation(() => appInstance as never);

    const processRepository = vi
      .fn()
      .mockResolvedValueOnce("ok-alpha")
      .mockResolvedValueOnce("ok-beta");
    const afterAll = vi.fn();

    await runForAllRepositories({
      scriptName: "test-script",
      processRepository,
      afterAll,
    });

    expect(processRepository).toHaveBeenCalledTimes(2);
    expect(afterAll).toHaveBeenCalledWith({
      results: [
        { repo: "org/alpha", result: "ok-alpha" },
        { repo: "org/beta", result: "ok-beta" },
      ],
      failedRepos: [],
      failedInstallations: [],
    });
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("includes both repo and installation failures in reporting", async () => {
    const installationOneOctokit = {
      paginate: vi.fn().mockResolvedValue([
        { owner: { login: "org" }, name: "alpha", full_name: "org/alpha" },
        { owner: { login: "org" }, name: "beta", full_name: "org/beta" },
      ]),
      rest: { apps: { listReposAccessibleToInstallation: vi.fn() } },
    };
    const appInstance = {
      octokit: {
        paginate: vi.fn().mockResolvedValue([
          { id: 1, account: { login: "inst-one" } },
          { id: 2, account: { login: "inst-two" } },
        ]),
        rest: { apps: { listInstallations: vi.fn() } },
      },
      getInstallationOctokit: vi
        .fn()
        .mockResolvedValueOnce(installationOneOctokit)
        .mockRejectedValueOnce(new Error("installation lookup failed")),
    };
    mockApp.mockImplementation(() => appInstance as never);

    const processRepository = vi
      .fn()
      .mockResolvedValueOnce("ok-alpha")
      .mockRejectedValueOnce(new Error("repo failed"));
    const afterAll = vi.fn();

    await expect(
      runForAllRepositories({
        scriptName: "test-script",
        processRepository,
        afterAll,
      })
    ).rejects.toThrow("exit:1");

    expect(afterAll).toHaveBeenCalledWith({
      results: [{ repo: "org/alpha", result: "ok-alpha" }],
      failedRepos: ["org/beta"],
      failedInstallations: [2],
    });
    expect(mockSetFailed).toHaveBeenCalledWith(
      "Failed to process repositories: org/beta; installations: 2"
    );
  });

  it("fails fast when app config cannot be loaded", async () => {
    mockGetAppConfig.mockImplementation(() => {
      throw new Error("missing APP_ID");
    });

    await expect(
      runForAllRepositories({
        scriptName: "test-script",
        processRepository: vi.fn(),
      })
    ).rejects.toThrow("exit:1");

    expect(mockSetFailed).toHaveBeenCalledWith("missing APP_ID");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runIfMain executes main only for matching entry URL", async () => {
    const originalArgv = [...process.argv];
    process.argv[1] = "/tmp/entry.js";
    const callerUrl = new URL(process.argv[1], "file://").href;

    const main = vi.fn().mockResolvedValue(undefined);
    runIfMain(callerUrl, main);
    await Promise.resolve();

    expect(main).toHaveBeenCalledTimes(1);

    const otherMain = vi.fn().mockResolvedValue(undefined);
    runIfMain("file:///tmp/another.js", otherMain);
    await Promise.resolve();

    expect(otherMain).not.toHaveBeenCalled();
    process.argv = originalArgv;
  });

  it("runIfMain marks failure when main rejects", async () => {
    const originalArgv = [...process.argv];
    process.argv[1] = "/tmp/entry.js";
    const callerUrl = new URL(process.argv[1], "file://").href;

    const main = vi.fn().mockRejectedValue(new Error("boom"));
    runIfMain(callerUrl, main);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSetFailed).toHaveBeenCalledWith("Fatal error: boom");
    expect(mockExit).toHaveBeenCalledWith(1);
    process.argv = originalArgv;
  });
});
