// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server for the job view of the admin portal (#541): the real database and the
// secrets the app knows (to take them out of a view should one slip through). Pages ask for the service
// here; tests build their own with `createAdminRunsService`.
import "server-only";
import { createJobDirectoryRepository } from "../db/repositories/job-directory-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { knownSecretsFromEnv, redactText } from "../runner-api/redact.ts";
import {
  createAdminRunsService,
  type AdminRunsService,
} from "./runs-service.ts";

export function adminRunsService(): AdminRunsService {
  return createAdminRunsService({
    directory: createJobDirectoryRepository(getDatabase()),
    // Read on every call: the keys can change while the server runs.
    redact: (text) => redactText(text, knownSecretsFromEnv(process.env)),
  });
}
