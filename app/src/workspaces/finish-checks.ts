// SPDX-License-Identifier: Apache-2.0

// The check runs a deleted workspace leaves behind (#658). A review that waited in the queue shows "Waiting" on its pull
// request through a check run (src/check-runs/README.md); the deletion removes the job, so nothing would ever complete that
// check run. After the deletion has committed, each one is completed on the platform with a conclusion that is not red and a
// short reason. Best effort and never in the way of the deletion: a connection that cannot be reached (the App is not
// configured, its token cannot be obtained, the installation is gone) is one log line with a stable code and ids only, and
// the remaining check runs of that connection are not tried.
import { CHECK_NAME } from "../check-runs/service.ts";
import type { OpenCheck } from "../db/repositories/workspace-erasure-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Integration } from "../integrations/types.ts";

/** What the deletion hands over after it committed: the connections it released and the check runs that stay open. */
export type ChecksToFinish = {
  workspaceId: string;
  integrations: Integration[];
  checks: OpenCheck[];
};

export type CheckFinisher = (work: ChecksToFinish) => Promise<void>;

/** The words of the completed check run. */
export const DELETED_CHECK_TITLE = "Workspace deleted";
export const DELETED_CHECK_SUMMARY = "The workspace was deleted.";

/** The longest the calls to the platform take altogether: the person waits for the answer of the deletion. */
const DEFAULT_BUDGET_MS = 10_000;

export function createCheckFinisher({
  registry,
  log = (line) => console.error(line),
  budgetMs = DEFAULT_BUDGET_MS,
}: {
  registry: Pick<IntegrationRegistry, "resolve">;
  log?: (line: string) => void;
  budgetMs?: number;
}): CheckFinisher {
  return async ({ workspaceId, integrations, checks }) => {
    if (checks.length === 0) return;
    const signal = AbortSignal.timeout(budgetMs);
    const failed = new Map<string, string>();
    let left = 0;
    for (const check of checks) {
      const integration = integrations.find(
        (item) => item.id === check.repo.integrationId,
      );
      if (integration === undefined || failed.has(integration.id)) {
        left += 1;
        continue;
      }
      try {
        const provider = registry.resolve(integration.type);
        if (provider.publishReviewCheck === undefined)
          throw new IntegrationError(
            "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
            "The connection cannot show a check run.",
          );
        await provider.publishReviewCheck(
          integration,
          check.repo,
          {
            jobId: check.jobId,
            headSha: check.headSha,
            name: CHECK_NAME,
            status: "completed",
            conclusion: "neutral",
            title: DELETED_CHECK_TITLE,
            summary: DELETED_CHECK_SUMMARY,
          },
          {
            checkRunId: check.checkRunId,
            // The attempt to make it may have worked without its id being kept: it is looked for by the job.
            mayExist: check.checkRunId === null,
            createIfMissing: false,
          },
          signal,
        );
      } catch (error) {
        failed.set(
          integration.id,
          error instanceof IntegrationError ? error.code : "CHECK_RUN_ERROR",
        );
        left += 1;
      }
    }
    if (failed.size > 0)
      log(
        `[workspaces] CHECK_RUN_NOT_COMPLETED workspace ${workspaceId}: ${String(left)} of ${String(checks.length)} check runs stay open (${[...new Set(failed.values())].join(", ")})`,
      );
  };
}
