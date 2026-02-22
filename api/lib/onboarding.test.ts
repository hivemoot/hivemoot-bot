import { describe, it, expect, vi, beforeEach } from "vitest";
import * as yaml from "js-yaml";
import {
  createOnboardingService,
  DEFAULT_CONFIG_YAML,
  type OnboardingClient,
  type OnboardingService,
} from "./onboarding.js";

function buildMockClient(): OnboardingClient {
  return {
    rest: {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { archived: false, disabled: false, default_branch: "main" },
        }),
        getContent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
        getBranch: vi.fn().mockResolvedValue({
          data: { commit: { sha: "abc123" } },
        }),
      },
      git: {
        createRef: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { number: 1, html_url: "https://github.com/test/repo/pull/1" },
        }),
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
  };
}

describe("createOnboardingService", () => {
  it("should create service from a valid client", () => {
    const client = buildMockClient();
    const service = createOnboardingService(client);
    expect(service).toHaveProperty("createOnboardingPR");
    expect(typeof service.createOnboardingPR).toBe("function");
  });

  it("should throw for invalid client", () => {
    expect(() => createOnboardingService({})).toThrow("Invalid GitHub client");
  });

  it("should throw for client missing pulls.list", () => {
    const client = buildMockClient();
    // @ts-expect-error intentionally breaking the interface
    delete client.rest.pulls.list;
    expect(() => createOnboardingService(client)).toThrow("Invalid GitHub client");
  });
});

describe("OnboardingService", () => {
  let client: OnboardingClient;
  let service: OnboardingService;

  beforeEach(() => {
    client = buildMockClient();
    service = createOnboardingService(client);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Skip conditions
  // ─────────────────────────────────────────────────────────────────────────

  it("should skip archived repos", async () => {
    vi.mocked(client.rest.repos.get).mockResolvedValue({
      data: { archived: true, disabled: false, default_branch: "main" },
    });

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "archived" });
    expect(client.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("should skip disabled repos", async () => {
    vi.mocked(client.rest.repos.get).mockResolvedValue({
      data: { archived: false, disabled: true, default_branch: "main" },
    });

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "archived" });
  });

  it("should skip when config already exists", async () => {
    vi.mocked(client.rest.repos.getContent).mockResolvedValue({ data: { type: "file", content: "" } });

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "config-exists" });
    expect(client.rest.pulls.list).not.toHaveBeenCalled();
  });

  it("should skip when an open PR already exists", async () => {
    vi.mocked(client.rest.pulls.list).mockResolvedValue({
      data: [{ number: 5, state: "open" }],
    });

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "pr-exists" });
    expect(client.rest.pulls.list).toHaveBeenCalledWith({
      owner: "test",
      repo: "repo",
      head: "test:hivemoot/configure",
      state: "all",
    });
  });

  it("should skip when a previously closed PR exists", async () => {
    vi.mocked(client.rest.pulls.list).mockResolvedValue({
      data: [{ number: 3, state: "closed" }],
    });

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "pr-previously-closed" });
  });

  it("should skip empty repos (default branch 404)", async () => {
    vi.mocked(client.rest.repos.getBranch).mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const result = await service.createOnboardingPR("test", "repo");
    expect(result).toEqual({ status: "skipped", reason: "empty-repo" });
    expect(client.rest.git.createRef).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Happy path
  // ─────────────────────────────────────────────────────────────────────────

  it("should create full onboarding PR sequence", async () => {
    const result = await service.createOnboardingPR("hivemoot", "colony");

    expect(result).toEqual({
      status: "created",
      prNumber: 1,
      prUrl: "https://github.com/test/repo/pull/1",
    });

    // Verify the complete sequence
    expect(client.rest.repos.get).toHaveBeenCalledWith({ owner: "hivemoot", repo: "colony" });
    expect(client.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      path: ".github/hivemoot.yml",
    });
    expect(client.rest.pulls.list).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      head: "hivemoot:hivemoot/configure",
      state: "all",
    });
    expect(client.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      branch: "main",
    });
    expect(client.rest.git.createRef).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      ref: "refs/heads/hivemoot/configure",
      sha: "abc123",
    });
    expect(client.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      path: ".github/hivemoot.yml",
      message: "Add default Hivemoot configuration",
      content: expect.any(String),
      branch: "hivemoot/configure",
    });
    expect(client.rest.pulls.create).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "colony",
      title: "Configure Hivemoot",
      body: expect.stringContaining("Welcome to Hivemoot"),
      head: "hivemoot/configure",
      base: "main",
    });
  });

  it("should encode config content as base64", async () => {
    await service.createOnboardingPR("test", "repo");

    const call = vi.mocked(client.rest.repos.createOrUpdateFileContents).mock.calls[0][0];
    const decoded = Buffer.from(call.content, "base64").toString("utf-8");
    expect(decoded).toBe(DEFAULT_CONFIG_YAML);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Race condition handling
  // ─────────────────────────────────────────────────────────────────────────

  it("should handle createRef 422 and still create PR", async () => {
    vi.mocked(client.rest.git.createRef).mockRejectedValue(
      Object.assign(new Error("Reference already exists"), { status: 422 })
    );

    const result = await service.createOnboardingPR("test", "repo");
    expect(result.status).toBe("created");
    expect(client.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    expect(client.rest.pulls.create).toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Error propagation
  // ─────────────────────────────────────────────────────────────────────────

  it("should propagate non-404 getContent errors", async () => {
    vi.mocked(client.rest.repos.getContent).mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 })
    );

    await expect(service.createOnboardingPR("test", "repo")).rejects.toThrow("Server Error");
  });

  it("should propagate non-422 createRef errors", async () => {
    vi.mocked(client.rest.git.createRef).mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 })
    );

    await expect(service.createOnboardingPR("test", "repo")).rejects.toThrow("Server Error");
  });

  it("should propagate non-404 getBranch errors", async () => {
    vi.mocked(client.rest.repos.getBranch).mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );

    await expect(service.createOnboardingPR("test", "repo")).rejects.toThrow("Forbidden");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Config content validation
  // ─────────────────────────────────────────────────────────────────────────

  it("should produce parseable YAML matching default config structure", () => {
    const parsed = yaml.load(DEFAULT_CONFIG_YAML) as Record<string, unknown>;
    expect(parsed).toHaveProperty("version", 1);
    expect(parsed).toHaveProperty("governance");
    expect(parsed).toHaveProperty("team");

    // Verify team roles
    const team = parsed.team as { roles: Record<string, unknown> };
    expect(team.roles).toHaveProperty("pm");
    expect(team.roles).toHaveProperty("engineer");
    expect(team.roles).toHaveProperty("reviewer");

    // Each role should have description and instructions
    for (const [, role] of Object.entries(team.roles)) {
      const r = role as { description: string; instructions: string };
      expect(typeof r.description).toBe("string");
      expect(typeof r.instructions).toBe("string");
    }

    const governance = parsed.governance as Record<string, unknown>;
    expect(governance).toHaveProperty("proposals");

    const proposals = governance.proposals as Record<string, unknown>;
    expect(proposals).toHaveProperty("discussion");
    expect(proposals).toHaveProperty("voting");
    expect(proposals).toHaveProperty("extendedVoting");

    // Verify all exits are manual (matching getDefaultConfig)
    const discussion = proposals.discussion as { exits: Array<{ type: string }> };
    expect(discussion.exits).toEqual([{ type: "manual" }]);

    const voting = proposals.voting as { exits: Array<{ type: string }> };
    expect(voting.exits).toEqual([{ type: "manual" }]);

    const extendedVoting = proposals.extendedVoting as { exits: Array<{ type: string }> };
    expect(extendedVoting.exits).toEqual([{ type: "manual" }]);

    // PR section is commented out by default — should not be present in parsed YAML
    expect(governance).not.toHaveProperty("pr");
  });

  it("should include bot signature in PR body", async () => {
    await service.createOnboardingPR("test", "repo");

    const call = vi.mocked(client.rest.pulls.create).mock.calls[0][0];
    expect(call.body).toContain("buzz buzz");
    expect(call.body).toContain("Hivemoot Queen");
  });
});
