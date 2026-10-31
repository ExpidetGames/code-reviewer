// SPDX-License-Identifier: LicenseRef-Proprietary

// The write token of a turn of the Implementer ends with the turn (#753, review of #776). `implementerAccess` hands out a token
// that lives up to an hour and may push to one repository; nothing may keep it alive after its job. Two moments:
//
//  - the token never reached the Worker (the fetch failed after it was made): `revoke` ends it at once, with the value in hand;
//  - the turn is over (the result is stored, or the job is given back): `revoke` ends every token the fetches of the claim made,
//    which `claimed-keys.ts` kept sealed for exactly this.
//
// Switching a token off is best effort and never fails the caller: a token that is gone, a refusal or a platform that is down
// leave it to expire at its time. The log names the job and a count, never a token.
import type { Job } from "../jobs/job-types.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";

/**
 * Switches off the write tokens of an implementer job: those the claim remembered, and `extra` (a token in hand that may not
 * be remembered). Does nothing for a job of another kind. Never rejects.
 */
export type WriteTokenRevoker = (
  job: Job,
  extra?: readonly string[],
) => Promise<void>;

export function createWriteTokenRevoker(deps: {
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  registry: IntegrationRegistry;
  claimedKeys: Pick<ClaimedKeys, "takeGitTokens">;
  logger: RunnerApiLogger;
}): WriteTokenRevoker {
  return async (job, extra = []) => {
    if (job.reviewKind !== "implementer") return;
    try {
      const remembered = await deps.claimedKeys
        .takeGitTokens(job.id)
        .catch((error: unknown) => {
          // The tokens we could not read are left to expire; the ones in hand are still switched off.
          deps.logger.error(
            `[runner-api] job=${job.id} the write tokens could not be read: ${describeError(error)}`,
          );
          return [] as string[];
        });
      const tokens = [...new Set([...remembered, ...extra])];
      if (tokens.length === 0) return;
      const repository = await deps
        .repositories(job.workspaceId)
        .get(job.repositoryId);
      const integration =
        repository === undefined
          ? undefined
          : await deps
              .integrations(job.workspaceId)
              .get(repository.integrationId);
      if (integration === undefined) {
        deps.logger.error(
          `[runner-api] job=${job.id} ${String(tokens.length)} write token(s) not switched off: the connection is gone`,
        );
        return;
      }
      const provider = deps.registry.resolve(integration.type);
      await Promise.all(
        tokens.map((token) =>
          provider.revokeImplementerAccess(integration, token),
        ),
      );
      deps.logger.info(
        `[runner-api] job=${job.id} ${String(tokens.length)} write token(s) switched off`,
      );
    } catch (error) {
      // No error text beyond its description: the failing layer may hold anything.
      deps.logger.error(
        `[runner-api] job=${job.id} write tokens could not be switched off: ${describeError(error)}`,
      );
    }
  };
}
