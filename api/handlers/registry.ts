import type { HandlerEventMap } from "./types.js";
import {
  installationCreatedLabelBootstrapHandler,
  installationRepositoriesAddedLabelBootstrapHandler,
} from "./label-bootstrap.handler.js";

export const handlerEventMap: HandlerEventMap = {
  "installation.created": [installationCreatedLabelBootstrapHandler],
  "installation_repositories.added": [installationRepositoriesAddedLabelBootstrapHandler],
};
