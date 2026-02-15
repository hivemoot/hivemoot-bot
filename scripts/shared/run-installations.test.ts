import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSetFailed,
  mockGetAppConfig,
  mockProcessExit,
  mockPaginate,
  mockGetInstallationOctokit,
} = vi.hoisted(() => ({
  mockSetFailed: vi.fn(),
  mockGetAppConfig: vi.fn(),
  mockProcessExit: vi.fn((code?: string | number | null) => {
    throw new Error(`process.exit:${code ?? ""}`);
  }),
  mockPaginate: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: mockSetFailed,
}));

vi.mock("../../api/lib/env-validation.js", () => ({
  getAppConfig: mockGetAppConfig,
}));

vi.mock("../../api/lib/index.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("octokit", () => {
  class App {
    octokit = {
      paginate: mockPaginate,
      rest: {
        apps: {
          listInstallations: vi.fn(),
        },
      },
    };

    getInstallationOctokit = mockGetInstallationOctokit;
  }

  class Octokit {}

  return { App, Octokit };
});

import { logger } from "../../api/lib/index.js";
import { runForAllRepositories, runIfMain } from "./run-installations.js";

describe("runForAllRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(mockProcessExit as never);

    mockGetAppConfig.mockReturnValue({
      appId: 123,
      privateKey: "private-key",
    });

    mockPaginate.mockResolvedValue([]);
    mockGetInstallationOctokit.mockReset();
  });

  it("fails closed when app config is invalid", async () => {
    mockGetAppConfig.mockImplementation(() => {
      throw new Error("missing APP_ID");
    });

    await expect(
      runForAllRepositories({
        scriptName: "test-script",
        processRepository: vi.fn(),
      })
    ).rejects.toThrow("process.exit:1");

    expect(mockSetFailed).toHaveBeenCalledWith("missing APP_ID");
  });

  it("collects failed repositories and reports them", async () => {
    const octokitForInstallation = {
      paginate: vi.fn().mockResolvedValue([
        { full_name: "org/repo-a" },
        { full_name: "org/repo-b" },
      ]),
      rest: {
        apps: {
          listReposAccessibleToInstallation: vi.fn(),
        },
      },
    };

    mockPaginate.mockResolvedValue([{ id: 1, account: { login: "org" } }]);
    mockGetInstallationOctokit.mockResolvedValue(octokitForInstallation);

    const processRepository = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await expect(
      runForAllRepositories({
        scriptName: "test-script",
        processRepository,
      })
    ).rejects.toThrow("process.exit:1");

    expect(processRepository).toHaveBeenCalledTimes(2);
    expect(mockSetFailed).toHaveBeenCalledWith("Failed to process: org/repo-a");
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to process org/repo-a",
      expect.any(Error)
    );
  });

  it("reports installation-level failures without repo list", async () => {
    mockPaginate.mockResolvedValue([{ id: 2, account: { login: "broken" } }]);
    mockGetInstallationOctokit.mockRejectedValue(new Error("installation token failed"));

    await expect(
      runForAllRepositories({
        scriptName: "test-script",
        processRepository: vi.fn(),
      })
    ).rejects.toThrow("process.exit:1");

    expect(mockSetFailed).toHaveBeenCalledWith("Some installations failed to process");
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to process installation 2",
      expect.any(Error)
    );
  });

  it("provides aggregated context to afterAll and succeeds", async () => {
    const octokitForInstallation = {
      paginate: vi.fn().mockResolvedValue([{ full_name: "org/repo-a" }]),
      rest: {
        apps: {
          listReposAccessibleToInstallation: vi.fn(),
        },
      },
    };

    mockPaginate.mockResolvedValue([{ id: 1, account: { login: "org" } }]);
    mockGetInstallationOctokit.mockResolvedValue(octokitForInstallation);

    const processRepository = vi.fn().mockResolvedValue("ok");
    const afterAll = vi.fn();

    await runForAllRepositories({
      scriptName: "test-script",
      processRepository,
      afterAll,
    });

    expect(afterAll).toHaveBeenCalledWith({
      failedRepos: [],
      results: [{ repo: "org/repo-a", result: "ok" }],
    });
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});

describe("runIfMain", () => {
  const mockExitNoThrow = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(mockExitNoThrow as never);
  });

  it("runs main when callerUrl matches argv[1]", async () => {
    const main = vi.fn().mockResolvedValue(undefined);
    process.argv[1] = "/tmp/test-script.ts";

    runIfMain("file:///tmp/test-script.ts", main);

    await vi.waitFor(() => {
      expect(main).toHaveBeenCalledTimes(1);
    });
  });

  it("does not run main when callerUrl differs", () => {
    const main = vi.fn().mockResolvedValue(undefined);
    process.argv[1] = "/tmp/another-script.ts";

    runIfMain("file:///tmp/test-script.ts", main);

    expect(main).not.toHaveBeenCalled();
  });

  it("fails closed when main rejects", async () => {
    const main = vi.fn().mockRejectedValue(new Error("fatal"));
    process.argv[1] = "/tmp/test-script.ts";

    runIfMain("file:///tmp/test-script.ts", main);

    await vi.waitFor(() => {
      expect(mockSetFailed).toHaveBeenCalledWith("Fatal error: fatal");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  it("does not run when argv[1] is missing", () => {
    const main = vi.fn().mockResolvedValue(undefined);
    const originalArgv1 = process.argv[1];
    delete process.argv[1];

    runIfMain("file:///tmp/test-script.ts", main);

    expect(main).not.toHaveBeenCalled();
    process.argv[1] = originalArgv1;
  });
});
