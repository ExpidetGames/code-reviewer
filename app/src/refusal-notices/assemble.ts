// SPDX-License-Identifier: Apache-2.0

// Puts the notice service together from a database: the repositories of the workspace of each refusal, the
// registry that knows how to write to a platform, and the one thing the instance decides, where the plan page is.
// The running server (shared.ts) and the tests make it the same way.
import type { Kysely } from "kysely";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createRefusalNoticesRepository } from "../db/repositories/refusal-notices-repository.ts";
import { listDueRefusalNotices } from "../db/repositories/refusal-notices-sweep.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import {
  createRefusalNoticeService,
  type RefusalNoticeDeps,
  type RefusalNoticeService,
} from "./service.ts";

export type RefusalNoticeAssembly = {
  db: Kysely<Database>;
  registry: Pick<IntegrationRegistry, "resolve">;
  planPageUrl: RefusalNoticeDeps["planPageUrl"];
  log: RefusalNoticeDeps["log"];
  now?: () => Date;
};

export function assembleRefusalNoticeService(
  assembly: RefusalNoticeAssembly,
): RefusalNoticeService {
  const { db } = assembly;
  const now = assembly.now ?? (() => new Date());
  return createRefusalNoticeService({
    jobs: (workspaceId) => createJobsRepository(db, workspaceId),
    repositories: (workspaceId) =>
      createRepositoriesRepository(db, workspaceId, now),
    integrations: (workspaceId) =>
      createIntegrationsRepository(db, workspaceId, now),
    workspaces: createWorkspacesRepository(db),
    notices: (workspaceId) =>
      createRefusalNoticesRepository(db, workspaceId, now),
    dueNotices: (at, options) => listDueRefusalNotices(db, at, options),
    registry: assembly.registry,
    planPageUrl: assembly.planPageUrl,
    now,
    log: assembly.log,
  });
}
