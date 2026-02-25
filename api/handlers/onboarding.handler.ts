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

interface OnboardingWebhookContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  payload: InstallationPayload;
}

function getOnboardingWebhookContext(event: HandlerEvent): OnboardingWebhookContext {
  return event.context as OnboardingWebhookContext;
}

function getOwner(repository: InstallationRepoPayload): string {
  const ownerFromFullName = repository.full_name.split("/")[0];
  return repository.owner?.login ?? ownerFromFullName ?? "";
}

async function createOnboardingForRepositories(
  context: OnboardingWebhookContext,
  repositories: readonly InstallationRepoPayload[] | undefined,
  eventName: string,
): Promise<void> {
  const targetRepositories = repositories ?? [];
  if (targetRepositories.length === 0) {
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
