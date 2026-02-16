import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for reconcile-repository-labels script.
 */

vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

process.on("unhandledRejection", () => {});

const mockEnsureRequiredLabels = vi.fn().mockResolvedValue({
  created: 0,
  renamed: 0,
  updated: 0,
  skipped: 0,
});

vi.mock("../api/lib/index.js", () => ({
  createRepositoryLabelService: vi.fn(() => ({
    ensureRequiredLabels: mockEnsureRequiredLabels,
  })),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("./shared/run-installations.js", () => ({
  runForAllRepositories: vi.fn(),
  runIfMain: vi.fn(),
}));

import { processRepository } from "./reconcile-repository-labels.js";
import { createRepositoryLabelService, logger } from "../api/lib/index.js";
import type { Repository } from "../api/lib/index.js";

const testRepo: Repository = {
  owner: { login: "test-org" },
  name: "test-repo",
  full_name: "test-org/test-repo",
};

describe("reconcile-repository-labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processRepository", () => {
    it("should reconcile labels and return result counts", async () => {
      mockEnsureRequiredLabels.mockResolvedValue({
        created: 2,
        renamed: 1,
        updated: 3,
        skipped: 8,
      });

      const result = await processRepository({} as never, testRepo, 12345);

      expect(vi.mocked(createRepositoryLabelService)).toHaveBeenCalled();
      expect(mockEnsureRequiredLabels).toHaveBeenCalledWith("test-org", "test-repo");
      expect(result).toEqual({
        created: 2,
        renamed: 1,
        updated: 3,
        skipped: 8,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.stringContaining("Label reconciliation complete")
      );
    });

    it("should close logger group when reconciliation fails", async () => {
      mockEnsureRequiredLabels.mockRejectedValue(new Error("api failure"));

      await expect(processRepository({} as never, testRepo, 12345)).rejects.toThrow("api failure");

      expect(vi.mocked(logger.group)).toHaveBeenCalledWith("Processing test-org/test-repo");
      expect(vi.mocked(logger.groupEnd)).toHaveBeenCalled();
    });
  });
});
