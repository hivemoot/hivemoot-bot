import { createOnboardingService } from "../lib/index.js";
import type { Handler, HandlerEvent } from "./types.js";

interface InstallationRepoPayload {
  owner?: { login?: string } | null;
  name: string;
  full_name: string;
}

interface InstallationPayload {
  repositories?: readonly InstallationRepoPayload[];
  repositories_added?: readonly InstallationRepoPayload[];
}

interface InstallationRepoListClient {
  rest: {
    apps: {
      listReposAccessibleToInstallation: (params: {
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: {
          repositories?: InstallationRepoPayload[];
        };
      }>;
    };
  };
}

interface OnboardingWebhookContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  payload: InstallationPayload;
}

const INSTALLATION_REPO_PAGE_SIZE = 100;

function getOnboardingWebhookContext(event: HandlerEvent): OnboardingWebhookContext {
  return event.context as OnboardingWebhookContext;
}

function getOwner(repository: InstallationRepoPayload): string {
  const ownerFromFullName = repository.full_name.split("/")[0];
  return repository.owner?.login ?? ownerFromFullName ?? "";
}

function hasInstallationRepoListClient(octokit: unknown): octokit is InstallationRepoListClient {
  if (typeof octokit !== "object" || octokit === null) {
    return false;
  }
  const client = octokit as {
    rest?: {
      apps?: {
        listReposAccessibleToInstallation?: unknown;
      };
    };
  };
  return typeof client.rest?.apps?.listReposAccessibleToInstallation === "function";
}

async function listAccessibleInstallationRepositories(
  octokit: unknown,
  eventName: string,
): Promise<InstallationRepoPayload[]> {
  if (!hasInstallationRepoListClient(octokit)) {
    throw new Error(
      `[${eventName}] Unable to list installation repositories: missing apps.listReposAccessibleToInstallation`,
    );
  }

  const repositories: InstallationRepoPayload[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: INSTALLATION_REPO_PAGE_SIZE,
      page,
    });

    const pageRepositories = Array.isArray(data.repositories) ? data.repositories : [];
    repositories.push(...pageRepositories);

    if (pageRepositories.length < INSTALLATION_REPO_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return repositories;
}

async function createOnboardingForRepositories(
  context: OnboardingWebhookContext,
  repositories: readonly InstallationRepoPayload[] | undefined,
  eventName: string,
): Promise<void> {
  const payloadRepositories = repositories ?? [];
  let targetRepositories: readonly InstallationRepoPayload[] = payloadRepositories;

  if (targetRepositories.length === 0) {
    context.log.info(
      `[${eventName}] Repository list missing from payload; fetching installation repositories`,
    );
    targetRepositories = await listAccessibleInstallationRepositories(context.octokit, eventName);
  }

  if (targetRepositories.length === 0) {
    context.log.info(`[${eventName}] No installation repositories available; skipping onboarding PR creation`);
    return;
  }

  let service: ReturnType<typeof createOnboardingService>;
  try {
    service = createOnboardingService(context.octokit);
  } catch {
    context.log.info(`[${eventName}] Onboarding service unavailable; skipping onboarding PR creation`);
    return;
  }

  for (const repository of targetRepositories) {
    const owner = getOwner(repository);
    const { name: repo, full_name: fullName } = repository;
    try {
      const result = await service.createOnboardingPR(owner, repo);
      if (result.skipped) {
        context.log.info(`[${eventName}] Onboarding PR skipped for ${fullName}: ${result.reason}`);
      } else {
        context.log.info(
          `[${eventName}] Onboarding PR #${result.prNumber} created for ${fullName}: ${result.prUrl}`,
        );
      }
    } catch (error) {
      context.log.error({ err: error, repo: fullName }, `[${eventName}] Failed to create onboarding PR`);
    }
  }
}

function createOnboardingHandler(
  name: string,
  repositorySelector: (payload: InstallationPayload) => readonly InstallationRepoPayload[] | undefined,
): Handler {
  return {
    name,
    async handle(event) {
      const context = getOnboardingWebhookContext(event);
      await createOnboardingForRepositories(
        context,
        repositorySelector(context.payload),
        event.name,
      );
    },
  };
}

export const installationCreatedOnboardingHandler = createOnboardingHandler(
  "onboarding-installation-created",
  (payload) => payload.repositories,
);

export const installationRepositoriesAddedOnboardingHandler = createOnboardingHandler(
  "onboarding-installation-repositories-added",
  (payload) => payload.repositories_added,
);
