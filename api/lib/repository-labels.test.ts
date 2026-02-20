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

/** Helper to build a label object matching the expected API shape. */
function label(name: string, color = "ededed", description: string | null = null) {
  return { name, color, description };
}

/** Look up the required definition for a canonical label name. */
function requiredDef(labelName: string) {
  return REQUIRED_REPOSITORY_LABELS.find((l) => l.name === labelName)!;
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
        iterator: vi.fn().mockReturnValue(buildIterator([[]])),
      },
    } as unknown as RepositoryLabelClient;

    service = new RepositoryLabelService(client);
  });

  it("should create all required labels when repository has none", async () => {
    const result = await service.ensureRequiredLabels("hivemoot", "colony");

    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length,
      renamed: 0,
      updated: 0,
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
    for (const l of REQUIRED_REPOSITORY_LABELS) {
      expect(client.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "colony",
          name: l.name,
          color: l.color,
          description: l.description,
        })
      );
    }
  });

  it("should skip labels that already exist with correct color and description", async () => {
    const discussionDef = requiredDef(LABELS.DISCUSSION);
    const mergeReadyDef = requiredDef(LABELS.MERGE_READY);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          label(LABELS.DISCUSSION, discussionDef.color, discussionDef.description),
          label(LABELS.MERGE_READY, mergeReadyDef.color, mergeReadyDef.description),
        ],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony");
    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length - 2,
      renamed: 0,
      updated: 0,
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
    const discussionDef = requiredDef(LABELS.DISCUSSION);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          label(LABELS.DISCUSSION.toUpperCase(), discussionDef.color, discussionDef.description),
        ],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony");
    expect(result).toEqual({
      created: REQUIRED_REPOSITORY_LABELS.length - 1,
      renamed: 0,
      updated: 0,
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
      updated: 0,
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
        [label("phase:voting", "5319e7", "Voting phase.")],
      ])
    );

    const votingLabel = requiredDef(LABELS.VOTING);
    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({
      created: 0,
      renamed: 1,
      updated: 0,
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
    const votingLabel = requiredDef(LABELS.VOTING);
    // Both old and new names exist — skip (canonical takes precedence, and has correct color)
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [
          label(LABELS.VOTING, votingLabel.color, votingLabel.description),
          label("phase:voting", "5319e7", "Voting phase."),
        ],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, updated: 0, skipped: 1, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).not.toHaveBeenCalled();
    expect(client.rest.issues.createLabel).not.toHaveBeenCalled();
  });

  it("should update label when color has drifted from required definition", async () => {
    // Label exists with wrong color (e.g., GitHub's default gray from addLabels)
    const votingLabel = requiredDef(LABELS.VOTING);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, "ededed", votingLabel.description)],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, updated: 1, skipped: 0, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      name: LABELS.VOTING,
      color: votingLabel.color,
      description: votingLabel.description,
    });
    expect(client.rest.issues.createLabel).not.toHaveBeenCalled();
  });

  it("should update label when description has drifted", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, votingLabel.color, "old description")],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, updated: 1, skipped: 0, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      name: LABELS.VOTING,
      color: votingLabel.color,
      description: votingLabel.description,
    });
  });

  it("should skip label when color and description match", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, votingLabel.color, votingLabel.description)],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, updated: 0, skipped: 1, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).not.toHaveBeenCalled();
  });

  it("should normalize color comparison (strip # prefix, case-insensitive)", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    // GitHub sometimes returns colors with uppercase hex
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, votingLabel.color.toUpperCase(), votingLabel.description)],
      ])
    );

    const result = await service.ensureRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result).toEqual({ created: 0, renamed: 0, updated: 0, skipped: 1, renamedLabels: [] });
    expect(client.rest.issues.updateLabel).not.toHaveBeenCalled();
  });
});

describe("RepositoryLabelService.auditRequiredLabels", () => {
  let client: RepositoryLabelClient;
  let service: RepositoryLabelService;

  beforeEach(() => {
    client = {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(),
          createLabel: vi.fn(),
          updateLabel: vi.fn(),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue(buildIterator([[]])),
      },
    } as unknown as RepositoryLabelClient;

    service = new RepositoryLabelService(client);
  });

  it("should report all required labels as missing when repo has none", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    const discussionLabel = requiredDef(LABELS.DISCUSSION);

    const result = await service.auditRequiredLabels("hivemoot", "colony", [votingLabel, discussionLabel]);

    expect(result.missing).toEqual([LABELS.VOTING, LABELS.DISCUSSION]);
    expect(result.colorMismatch).toHaveLength(0);
    expect(result.renameable).toHaveLength(0);
    expect(result.ok).toBe(0);
  });

  it("should report ok count for labels that exist with correct color and description", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, votingLabel.color, votingLabel.description)],
      ])
    );

    const result = await service.auditRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result.ok).toBe(1);
    expect(result.missing).toHaveLength(0);
    expect(result.colorMismatch).toHaveLength(0);
    expect(result.renameable).toHaveLength(0);
  });

  it("should report color mismatch for label with drifted color", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    const driftedColor = "aaaaaa";
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label(LABELS.VOTING, driftedColor, votingLabel.description)],
      ])
    );

    const result = await service.auditRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result.colorMismatch).toEqual([
      { name: LABELS.VOTING, current: driftedColor, expected: votingLabel.color },
    ]);
    expect(result.ok).toBe(0);
    expect(result.missing).toHaveLength(0);
    expect(result.renameable).toHaveLength(0);
  });

  it("should report renameable for label that exists only under legacy name", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);
    vi.mocked(client.paginate.iterator).mockReturnValue(
      buildIterator([
        [label("phase:voting", votingLabel.color, votingLabel.description)],
      ])
    );

    const result = await service.auditRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(result.renameable).toEqual([{ from: "phase:voting", to: LABELS.VOTING }]);
    expect(result.missing).toHaveLength(0);
    expect(result.ok).toBe(0);
  });

  it("should not mutate any labels during audit", async () => {
    const votingLabel = requiredDef(LABELS.VOTING);

    await service.auditRequiredLabels("hivemoot", "colony", [votingLabel]);

    expect(client.rest.issues.createLabel).not.toHaveBeenCalled();
    expect(client.rest.issues.updateLabel).not.toHaveBeenCalled();
  });
});
