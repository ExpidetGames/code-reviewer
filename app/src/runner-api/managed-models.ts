// SPDX-License-Identifier: LicenseRef-Proprietary

// Which models a job's result must hide (`ReportDeps.managedModels`, report.ts). One function for the running server
// (`shared.ts`) and the test harness, so that a test checks the code that runs.
import type { Job } from "../jobs/job-types.ts";
import type { UsageRecord } from "../db/repositories/usage-records-repository.ts";

/**
 * A run on the operator's key hides every model id of the catalog, whatever the status of its entry: the remembered model
 * of the job is not enough (its row may be unreadable, the runner may spell the model differently, and the result may
 * name another entry's model). A run on the workspace's own key hides nothing: that model is the workspace's own.
 */
export function managedModelsOf(deps: {
  usage: (job: Job) => Promise<Pick<UsageRecord, "keyMode"> | undefined>;
  catalog: { allCatalogModelIds: () => Promise<string[]> };
}): (job: Job) => Promise<{ managed: boolean; models: readonly string[] }> {
  return async (job) => {
    const record = await deps.usage(job);
    if (record?.keyMode !== "managed") return { managed: false, models: [] };
    return { managed: true, models: await deps.catalog.allCatalogModelIds() };
  };
}
