import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OnboardingService,
  createOnboardingService,
  ONBOARDING_BRANCH,
  type OnboardingClient,
} from "./onboarding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(): { client: OnboardingClient; mocks: ReturnType<typeof buildMocks> } {
  const mocks = buildMocks();
  const client: OnboardingClient = {
    rest: {
      repos: {
        get: mocks.reposGet,
        getContent: mocks.reposGetContent,
        createOrUpdateFileContents: mocks.reposCreateOrUpdateFileContents,
      },
      git: {
        getRef: mocks.gitGetRef,
        createRef: mocks.gitCreateRef,
      },
      pulls: {
        list: mocks.pullsList,
        create: mocks.pullsCreate,
      },
    },
  };
  return { client, mocks };
}

function buildMocks() {
  return {
    reposGet: vi.fn().mockResolvedValue({
      data: { default_branch: "main", archived: false },
    }),
    reposGetContent: vi.fn().mockRejectedValue({ status: 404 }),
    reposCreateOrUpdateFileContents: vi.fn().mockResolvedValue({}),
    gitGetRef: vi.fn().mockResolvedValue({
      data: { object: { sha: "abc1234" } },
    }),
    gitCreateRef: vi.fn().mockResolvedValue({}),
    pullsList: vi.fn().mockResolvedValue({ data: [] }),
    pullsCreate: vi.fn().mockResolvedValue({
      data: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createOnboardingService factory
// ─────────────────────────────────────────────────────────────────────────────

describe("createOnboardingService", () => {
  it("should throw on null", () => {
    expect(() => createOnboardingService(null)).toThrow();
  });

  it("should throw when rest.repos methods are missing", () => {
    expect(() => createOnboardingService({ rest: { git: {}, pulls: {} } })).toThrow();
  });

  it("should throw when rest.git methods are missing", () => {
    const { client } = makeClient();
    const broken = { ...client, rest: { ...client.rest, git: {} } };
    expect(() => createOnboardingService(broken)).toThrow();
  });

  it("should return a service for a valid client", () => {
    const { client } = makeClient();
    expect(createOnboardingService(client)).toBeInstanceOf(OnboardingService);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createOnboardingPR
// ─────────────────────────────────────────────────────────────────────────────

describe("OnboardingService.createOnboardingPR", () => {
  let service: OnboardingService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    const built = makeClient();
    service = new OnboardingService(built.client);
    mocks = built.mocks;
  });

  it("should skip archived repos", async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: "main", archived: true } });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "archived" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip when config file already exists", async () => {
    mocks.reposGetContent.mockResolvedValue({ data: { type: "file" } });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "config-exists" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip when an open onboarding PR already exists", async () => {
    mocks.pullsList.mockResolvedValue({
      data: [{ number: 7, html_url: "https://github.com/owner/repo/pull/7" }],
    });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "pr-exists", prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip empty repos (404 on getRef)", async () => {
    mocks.gitGetRef.mockRejectedValue({ status: 404 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "empty-repo" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should create branch, file, and PR for fresh repos", async () => {
    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });

    expect(mocks.gitGetRef).toHaveBeenCalledWith({ owner: "owner", repo: "repo", ref: "heads/main" });
    expect(mocks.gitCreateRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: `refs/heads/${ONBOARDING_BRANCH}`,
      sha: "abc1234",
    });
    expect(mocks.reposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        path: ".github/hivemoot.yml",
        branch: ONBOARDING_BRANCH,
      })
    );
    expect(mocks.pullsCreate).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      title: "Configure Hivemoot",
      body: expect.stringContaining("Welcome to Hivemoot"),
      head: ONBOARDING_BRANCH,
      base: "main",
    });
  });

  it("should use base64-encoded content for the config file", async () => {
    await service.createOnboardingPR("owner", "repo");

    const call = mocks.reposCreateOrUpdateFileContents.mock.calls[0][0] as { content: string };
    const decoded = Buffer.from(call.content, "base64").toString("utf-8");
    expect(decoded).toContain("version: 1");
    expect(decoded).toContain("governance:");
  });

  it("should handle branch-already-exists (422 on createRef) and continue", async () => {
    mocks.gitCreateRef.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });
    expect(mocks.reposCreateOrUpdateFileContents).toHaveBeenCalled();
    expect(mocks.pullsCreate).toHaveBeenCalled();
  });

  it("should handle file-already-on-branch (422 on createOrUpdateFileContents) and continue", async () => {
    mocks.reposCreateOrUpdateFileContents.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });
    expect(mocks.pullsCreate).toHaveBeenCalled();
  });

  it("should propagate non-422 errors from createRef", async () => {
    mocks.gitCreateRef.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should propagate non-404 errors from getRef", async () => {
    mocks.gitGetRef.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
  });

  it("should propagate non-404 errors from getContent", async () => {
    mocks.reposGetContent.mockRejectedValue({ status: 403 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 403 });
  });

  it("should use the repo's actual default branch (not hardcoded main)", async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: "master", archived: false } });

    await service.createOnboardingPR("owner", "repo");

    expect(mocks.gitGetRef).toHaveBeenCalledWith({ owner: "owner", repo: "repo", ref: "heads/master" });
    expect(mocks.pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ base: "master" })
    );
  });

  it("should filter open PRs by owner:branch head format", async () => {
    await service.createOnboardingPR("owner", "repo");

    expect(mocks.pullsList).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      state: "open",
      head: `owner:${ONBOARDING_BRANCH}`,
      per_page: 1,
    });
  });
});
