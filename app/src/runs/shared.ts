// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the real database, the real clock and the secrets the app knows
// (to take them out of a log should one slip through). Pages and routes ask for the service here;
// tests build their own with `createRunsService`.
import "server-only";
import { createRunsRepository } from "../db/repositories/runs-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { knownSecretsFromEnv, redactText } from "../runner-api/redact.ts";
import type { LastRunSource } from "../projects/ui/list-view.ts";
import {
  createLastRunSource,
  createRunsService,
  type RunsService,
} from "./runs-service.ts";

/** The runs service of one workspace. */
export function runsServiceFor(workspaceId: string): RunsService {
  return createRunsService({
    runs: createRunsRepository(getDatabase(), workspaceId),
    // Read on every call: the keys can change while the server runs.
    redact: (text) => redactText(text, knownSecretsFromEnv(process.env)),
  });
}

/** The status of each repository's last run in one workspace, for the project list. */
export function lastRunSourceFor(workspaceId: string): LastRunSource {
  return createLastRunSource({
    runs: createRunsRepository(getDatabase(), workspaceId),
  });
}
