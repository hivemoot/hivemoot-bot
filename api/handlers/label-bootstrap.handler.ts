import { createRepositoryLabelService } from "../lib/index.js";
import type { Handler, HandlerEvent } from "./types.js";

interface LabelBootstrapContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

interface LabelBootstrapSummary {
  reposProcessed: number;
  reposFailed: number;
  labelsCreated: number;
  labelsRenamed: number;
  labelsUpdated: number;
  labelsSkipped: number;
}

interface InstallationRepoPayload {
  owner?: { login?: string } | null;
  name: string;
  full_name: string;
}

interface InstallationPayload {
  repositories?: readonly InstallationRepoPayload[];
  repositories_added?: readonly InstallationRepoPayload[];
}

interface LabelBootstrapWebhookContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  payload: InstallationPayload;
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

const INSTALLATION_REPO_PAGE_SIZE = 100;

interface RepoContext {
  owner: string;
  repo: string;
  fullName: string;
}

function getLabelBootstrapWebhookContext(event: HandlerEvent): LabelBootstrapWebhookContext {
  return event.context as LabelBootstrapWebhookContext;
}

function getRepoContext(repository: InstallationRepoPayload): RepoContext {
  const ownerFromFullName = repository.full_name.split("/")[0];
  const owner = repository.owner?.login ?? ownerFromFullName;
  if (!owner) {
    throw new Error(`Unable to determine repository owner from '${repository.full_name}'`);
  }
  return {
    owner,
    repo: repository.name,
    fullName: repository.full_name,
  };
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

async function ensureLabelsForRepositories(
  context: LabelBootstrapContext,
  repositories: readonly InstallationRepoPayload[] | undefined,
  eventName: string,
): Promise<void> {
  const payloadRepositories = repositories ?? [];
  let targetRepositories = payloadRepositories;

  if (targetRepositories.length === 0) {
    context.log.info(
      `[${eventName}] Repository list missing from payload; fetching installation repositories`,
    );
    targetRepositories = await listAccessibleInstallationRepositories(context.octokit, eventName);
  }

  if (targetRepositories.length === 0) {
    context.log.info(`[${eventName}] No installation repositories available; skipping label bootstrap`);
    context.log.info(
      `[${eventName}] Label bootstrap summary: reposProcessed=0, reposFailed=0, labelsCreated=0, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
    return;
  }

  const labelService = createRepositoryLabelService(context.octokit);
  const errors: Error[] = [];
  const summary: LabelBootstrapSummary = {
    reposProcessed: targetRepositories.length,
    reposFailed: 0,
    labelsCreated: 0,
    labelsRenamed: 0,
    labelsUpdated: 0,
    labelsSkipped: 0,
  };

  for (const repository of targetRepositories) {
    const { owner, repo, fullName } = getRepoContext(repository);
    try {
      const result = await labelService.ensureRequiredLabels(owner, repo);
      summary.labelsCreated += result.created;
      summary.labelsRenamed += result.renamed;
      summary.labelsUpdated += result.updated;
      summary.labelsSkipped += result.skipped;
      context.log.info(
        `[${eventName}] Ensured labels in ${fullName}: created=${result.created}, renamed=${result.renamed}, updated=${result.updated}, skipped=${result.skipped}`,
      );
    } catch (error) {
      summary.reposFailed += 1;
      context.log.error({ err: error, repo: fullName }, `[${eventName}] Failed to ensure required labels`);
      errors.push(error as Error);
    }
  }

  context.log.info(
    `[${eventName}] Label bootstrap summary: reposProcessed=${summary.reposProcessed}, reposFailed=${summary.reposFailed}, labelsCreated=${summary.labelsCreated}, labelsRenamed=${summary.labelsRenamed}, labelsUpdated=${summary.labelsUpdated}, labelsSkipped=${summary.labelsSkipped}`,
  );

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} repository label bootstrap operation(s) failed`);
  }
}

function createLabelBootstrapHandler(
  name: string,
  repositorySelector: (payload: InstallationPayload) => readonly InstallationRepoPayload[] | undefined,
): Handler {
  return {
    name,
    async handle(event) {
      const context = getLabelBootstrapWebhookContext(event);
      await ensureLabelsForRepositories(
        { octokit: context.octokit, log: context.log },
        repositorySelector(context.payload),
        event.name,
      );
    },
  };
}

export const installationCreatedLabelBootstrapHandler = createLabelBootstrapHandler(
  "label-bootstrap-installation-created",
  (payload) => payload.repositories,
);

export const installationRepositoriesAddedLabelBootstrapHandler = createLabelBootstrapHandler(
  "label-bootstrap-installation-repositories-added",
  (payload) => payload.repositories_added,
);
