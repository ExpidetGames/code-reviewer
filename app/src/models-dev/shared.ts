// SPDX-License-Identifier: LicenseRef-Proprietary

// The models.dev service of the running server: the real database and the settings from the environment. The sweep, the
// timer of a long-lived server and the admin's "fetch now" (#554) all use it.
import "server-only";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import {
  createModelsDevAdminService,
  type ModelsDevAdminService,
} from "./admin-service.ts";
import { createModelsDevService, type ModelsDevService } from "./service.ts";

let service: ModelsDevService | undefined;

export function getModelsDevService(): ModelsDevService {
  service ??= createModelsDevService({ db: getDatabase() });
  return service;
}

/** The admin portal's side of the catalog (#554): the providers, the confirmation of an address and "fetch now". */
export function getModelsDevAdminService(): ModelsDevAdminService {
  const db = getDatabase();
  return createModelsDevAdminService({
    db,
    models: getModelsDevService(),
    rateLimits: createRateLimitsRepository(db),
  });
}
