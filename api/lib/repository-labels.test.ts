import { describe, it, expect, vi, beforeEach } from "vitest";
import { LABELS, REQUIRED_REPOSITORY_LABELS } from "../config.js";
import {
  RepositoryLabelService,
  createRepositoryLabelService,
  type RepositoryLabelClient,
} from "./repository-labels.js";

function buildIterator<T>(pages: T[][]): AsyncIterable<{ data: T[] }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
}

describe("createRepositoryLabelService", () => {
  it("should create service from a valid client", () => {
    const validClient = {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(),
          createLabel: vi.fn(),
          updateLabel: vi.fn(),
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };

    const service = createRepositoryLabelService(validClient);
    expect(service).toBeInstanceOf(RepositoryLabelService);
  });

  it("should throw for invalid client", () => {
    expect(() => createRepositoryLabelService({})).toThrow("Invalid GitHub client");
  });
});

describe("RepositoryLabelService", () => {
  let client: RepositoryLabelClient;
  let service: RepositoryLabelService;

  beforeEach(() => {
    client = {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(),
          createLabel: vi.fn().mockResolvedValue({}),
          updateLabel: vi.fn().mockResolvedValue({}),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue(buildIterator<{
          name: string;
        }>([[]])),
      },
    } as unknown as RepositoryLabelClient;

    service = new RepositoryLabelService(client);
  });

  it("should create all required labels when repository has none", async () => {
    const result = await service.ensureRequiredLabels("hivemoot", "colony");

    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length,
      renamed: 0,
      skipped: 0,
      renamedLabels: [],
    });

    expect(client.paginate.iterator).toHaveBeenCalledWith(
      client.rest.issues.listLabelsForRepo,
      {
        owner: "hivemoot",
        repo: "colony",
        per_page: 100,
      }
    );

    expect(client.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
    for (const label of REQUIRED_REPOSITORY_LABELS) {
      expect(client.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "colony",
          name: label.name,
          color: label.color,
          description: label.description,
        })
      );
    }
  });

  it("should skip labels that already exist", async () => {
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          { name: LABELS.DISCUSSION },
          { name: LABELS.MERGE_READY },
        ],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony");
    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length - 2,
      renamed: 0,
      skipped: 2,
      renamedLabels: [],
    });

    const createdNames = vi
      .mocked(client.rest.issues.createLabel)
      .mock.calls
      .map(([params]) => params.name);

    expect(createdNames).not.toContain(LABELS.DISCUSSION);
    expect(createdNames).not.toContain(LABELS.MERGE_READY);
  });

  it("should match existing label names case-insensitively", async () => {
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          { name: LABELS.DISCUSSION.toUpperCase() },
        ],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony");
    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length - 1,
      renamed: 0,
      skipped: 1,
      renamedLabels: [],
    });

    const createdNames = vi
      .mocked(client.rest.issues.createLabel)
      .mock.calls
      .map(([params]) => params.name);
    expect(createdNames).not.toContain(LABELS.DISCUSSION);
  });

  it("should treat 422 as already-created label and continue", async () => {
    const alreadyExistsError = new Error("Unprocessable Entity") as Error & {
      status: number;
    };
    alreadyExistsError.status = 422;

    vi.mocked(client.rest.issues.createLabel).mockImplementation(async ({ name }) => {
      if (name === LABELS.DISCUSSION) {
        throw alreadyExistsError;
      }
      return {};
    });

    const result = await service.ensureRequiredLabels("hivemoot", "colony");
    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length - 1,
      renamed: 0,
      skipped: 1,
      renamedLabels: [],
    });
  });

  it("should rethrow non-422 create errors", async () => {
    const serverError = new Error("Server Error") as Error & {
      status: number;
    };
    serverError.status = 500;

    vi.mocked(client.rest.issues.createLabel).mockRejectedValue(serverError);

    await expect(service.ensureRequiredLabels("hivemoot", "colony")).rejects.toThrow("Server Error");
  });

  it("should rename legacy label instead of creating duplicate", async () => {
    // Repo has "phase:voting" (legacy) but not "hivemoot:voting" (canonical)
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [{ name: "phase:voting" }],
      ])
    );

    const votingLabel = REQUIRED_REPOSITORY_LABELS.find(
      (l) => l.name === LABELS.VOTING
    )!;
    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({
      created: 0,
      renamed: 1,
      skipped: 0,
      renamedLabels: [{ from: "phase:voting", to: LABELS.VOTING }],
    });

    expect(client.rest.issues.updateLabel).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      name: "phase:voting",
      new_name: LABELS.VOTING,
      color: votingLabel.color,
      description: votingLabel.description,
    });
    expect(client.rest.issues.createLabel).not.toHaveBeenCalled();
  });

  it("should skip when canonical label already exists even if legacy also exists", async () => {
    // Both old and new names exist — skip (canonical takes precedence)
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          { name: LABELS.VOTING },
          { name: "phase:voting" },
        ],
      ])
    );

    const votingLabel = REQUIRED_REPOSITORY_LABELS.find(
      (l) => l.name === LABELS.VOTING
    )!;
    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, skipped: 1, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).not.toHaveBeenCalled();
    expect(client.rest.issues.createLabel).not.toHaveBeenCalled();
  });
});
