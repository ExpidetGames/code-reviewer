// SPDX-License-Identifier: LicenseRef-Proprietary

// The check run service on the running server (#405): the real database, the integration registry and the stored
// settings of the project. The queues (`src/jobs/shared.ts`) call `checkNotifier` after the response of the request
// that changed a job (`runAfterResponse`: Next's `after()`, which a serverless platform keeps the function alive for;
// never a timer), and the sweep, the opportunistic maintenance of a hosted deployment and the timer of a long-lived
// server call `getCheckRunService().reconcileDue()` for what no request named. Never delays or fails a request.
import "server-only";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJobCheckRunsRepository } from "../db/repositories/job-check-runs-repository.ts";
import { listJobsWithCheckWork } from "../db/repositories/job-check-runs-sweep.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createRunnerJobsRepository } from "../db/repositories/runner-jobs-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { REVIEW_DEFAULTS_KEY } from "../review-settings/settings.ts";
import type { CheckNotifier } from "./notifying-queues.ts";
import { createCheckRunService, type CheckRunService } from "./service.ts";
import { reviewVerdictOf } from "./verdict-mode.ts";

let service: CheckRunService | undefined;

/** One service per process: it keeps the order of the reconciles of this process. */
export function getCheckRunService(): CheckRunService {
  if (service !== undefined) return service;
  const db = getDatabase();
  // Only `get`: the service never changes a job.
  const jobs = createRunnerJobsRepository(db);
  service = createCheckRunService({
    product: getProductIdentity(),
    jobs: { get: (id) => jobs.get(id) },
    repositories: (workspaceId) =>
      createRepositoriesRepository(db, workspaceId),
    integrations: (workspaceId) =>
      createIntegrationsRepository(db, workspaceId),
    checks: (workspaceId) => createJobCheckRunsRepository(db, workspaceId),
    dueJobs: (now, options) => listJobsWithCheckWork(db, now, options),
    verdictMode: async (workspaceId, repositoryId) =>
      reviewVerdictOf(
        (await createProjectsRepository(db, workspaceId).get(repositoryId))
          ?.settings,
        (
          await createAppSettingsRepository(db, workspaceId).get(
            REVIEW_DEFAULTS_KEY,
          )
        )?.value,
      ),
    registry: integrationRegistry,
    now: () => new Date(),
    log: console,
  });
  return service;
}

/**
 * The time the work of a queue call is given. It runs in the `after()` of a request that has 60 seconds in all (a
 * webhook may have spent half a minute of it on its inline dispatch), and the opportunistic maintenance may follow.
 */
const AFTER_RESPONSE_BUDGET_MS = 15_000;

/** What the queues call: the work runs after the response and never rejects. */
export function createCheckNotifier(
  service: () => Pick<CheckRunService, "syncJob" | "reconcileDue">,
  after: (work: () => Promise<void>) => void,
): CheckNotifier {
  return {
    job(jobId) {
      after(() =>
        service().syncJob(jobId, { budgetMs: AFTER_RESPONSE_BUDGET_MS }),
      );
    },
    change() {
      after(async () => {
        await service().reconcileDue({ budgetMs: AFTER_RESPONSE_BUDGET_MS });
      });
    },
  };
}

export const checkNotifier: CheckNotifier = createCheckNotifier(
  getCheckRunService,
  runAfterResponse,
);
