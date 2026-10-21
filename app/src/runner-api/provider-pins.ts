// SPDX-License-Identifier: Apache-2.0

// Where a claim adopts the address of a selection made before pins existed (#588): the settings of the job's own workspace, for the
// job's own project. Kept apart from the wiring (shared.ts) so a test can run exactly this, and a wrong workspace or a no-op turns
// it red.
import type { Job } from "../jobs/job-types.ts";
import type { ReviewSettingsService } from "../review-settings/service.ts";

export type ProviderPins = {
  adopt: (
    job: Pick<Job, "workspaceId" | "repositoryId">,
    provider: string,
    address: string,
  ) => Promise<string | null>;
};

export function createProviderPins(
  settingsFor: (
    workspaceId: string,
  ) => Pick<ReviewSettingsService, "adoptProviderAddress">,
): ProviderPins {
  return {
    adopt: (job, provider, address) =>
      settingsFor(job.workspaceId).adoptProviderAddress(
        job.repositoryId,
        provider,
        address,
      ),
  };
}
