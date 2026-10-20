// SPDX-License-Identifier: Apache-2.0

// The models.dev service of the running server: the real database and the settings from the environment. The sweep, the
// timer of a long-lived server and (with #554) the admin's "fetch now" all use it.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { createModelsDevService, type ModelsDevService } from "./service.ts";

let service: ModelsDevService | undefined;

export function getModelsDevService(): ModelsDevService {
  service ??= createModelsDevService({ db: getDatabase() });
  return service;
}
