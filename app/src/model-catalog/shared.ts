// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server for the catalog routes of the admin portal (#429): the catalog on the server's
// database, the capability checks against the provider's own address (src/llm/shared.ts), and the audit line of a change
// of model on the server's log, which is the operator's: it names the provider and the model.
import "server-only";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { modelCapabilities } from "../llm/shared.ts";
import {
  createCatalogAdminService,
  type CatalogAdminService,
} from "./admin-service.ts";
import { createCatalogService, type CatalogService } from "./service.ts";

export function getCatalogService(): CatalogService {
  const db = getDatabase();
  return createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
    logger: { info: (line) => console.info(line) },
  });
}

/** The providers an entry can name, in the order of the registry. */
export function catalogProviders() {
  return llmProviderDescriptors.ids.map((id) => ({
    id,
    label: llmProviderDescriptors.labelOf(id),
  }));
}

export function getCatalogAdminService(): CatalogAdminService {
  return createCatalogAdminService({
    catalog: getCatalogService(),
    providers: catalogProviders,
  });
}
