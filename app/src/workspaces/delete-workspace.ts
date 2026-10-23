// SPDX-License-Identifier: Apache-2.0

// Deleting a workspace (#658). One transaction, decided from the database inside it (like every change of the members,
// src/workspaces/members.ts), so a caller that forgets a check still cannot delete: the person must be an Owner of this
// workspace right now, must have typed its name, and the workspace must be in a state that can end safely.
//
// Refused, with a stable code (the data stays exactly as it was):
// - `forbidden` / `not_found`: not an Owner / not a member (any more), or the workspace is deleted already;
// - `name_mismatch`: the typed name is not the workspace's name (exact, after trimming the ends);
// - `balance_positive`: unused prepaid credit. Until the owner of the product decides how credit is refunded, a deletion
//   would destroy money the customer paid for, so it waits (the person is told to contact support);
// - `review_running`: a review is running or still holds a reservation. It would report to a workspace that is gone, so the
//   person tries again when it has finished;
// - `payment_open`: a top-up checkout was started recently and may still be paid, which would credit a deleted workspace.
//
// What happens otherwise: the balance row is locked first (a top-up, a claim or a charge cannot slip in between the check
// and the deletion), the GitHub installations of the workspace are released (the connection rows go, and each installation
// is noted as unclaimed so another workspace, or this person's next one, can link it again; nothing is sent to GitHub, the
// App stays installed there until the person removes it), and the repository `WorkspaceErasure` removes the data and
// anonymises the row. The journal and the money records stay: see `workspace-erasure-repository.ts`.
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createWorkspaceErasureRepository } from "../db/repositories/workspace-erasure-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "./permissions.ts";

export const DELETE_WORKSPACE_ERROR_CODES = [
  "not_found",
  "forbidden",
  "name_mismatch",
  "balance_positive",
  "review_running",
  "payment_open",
] as const;
export type DeleteWorkspaceErrorCode =
  (typeof DELETE_WORKSPACE_ERROR_CODES)[number];

export const DELETE_WORKSPACE_ERROR_STATUS: Record<
  DeleteWorkspaceErrorCode,
  number
> = {
  not_found: 404,
  forbidden: 403,
  name_mismatch: 422,
  balance_positive: 409,
  review_running: 409,
  payment_open: 409,
};

/** A checkout older than this has ended at the provider (a session lasts 24 hours at most), whatever the row says. */
export const OPEN_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The name every deleted workspace carries; the address is `deleted-<id>`. */
export const DELETED_WORKSPACE_NAME = "Deleted workspace";

export type DeleteWorkspaceResult =
  { ok: true } | { ok: false; error: DeleteWorkspaceErrorCode };

export type WorkspaceDeletion = {
  /** Deletes the workspace for the Owner `actorId` who typed `confirmName`. */
  delete(input: {
    workspaceId: string;
    actorId: string;
    confirmName: unknown;
  }): Promise<DeleteWorkspaceResult>;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createWorkspaceDeletion({
  db,
  now = () => new Date(),
  log = (message) => console.log(message),
}: {
  db: Kysely<Database>;
  now?: () => Date;
  log?: (message: string) => void;
}): WorkspaceDeletion {
  return {
    async delete({ workspaceId, actorId, confirmName }) {
      const result = await db
        .transaction()
        .execute(async (trx): Promise<DeleteWorkspaceResult> => {
          const members = createWorkspaceMembersRepository(
            trx,
            workspaceId,
            now,
          );
          // The workspace row first, like every writer that follows (members, claims): one at a time.
          await members.lock();
          const actor = await members.get(actorId);
          if (actor === undefined) return { ok: false, error: "not_found" };
          if (!can(actor.role, "delete_workspace"))
            return { ok: false, error: "forbidden" };
          const workspace = await createWorkspacesRepository(trx, now).get(
            workspaceId,
          );
          if (workspace === undefined) return { ok: false, error: "not_found" };
          if (text(confirmName)?.trim() !== workspace.name)
            return { ok: false, error: "name_mismatch" };

          const journal = createBillingJournalRepository(trx, workspaceId, now);
          await journal.lockBalance();
          const balance = await journal.balance();
          if (balance.balanceMicroUsd > 0)
            return { ok: false, error: "balance_positive" };
          const erasure = createWorkspaceErasureRepository(
            trx,
            workspaceId,
            now,
          );
          if (balance.reservedMicroUsd > 0 || (await erasure.hasRunningJobs()))
            return { ok: false, error: "review_running" };
          if (
            await erasure.hasOpenPayment(
              new Date(now().getTime() - OPEN_PAYMENT_WINDOW_MS),
            )
          )
            return { ok: false, error: "payment_open" };

          const unclaimed = createUnclaimedInstallationsRepository(trx, now);
          for (const integration of await createIntegrationsRepository(
            trx,
            workspaceId,
            now,
          ).list()) {
            // One the person disconnected earlier is not noted again: it was let go on purpose.
            if (
              integration.type !== "github_app" ||
              integration.status === "disconnected"
            )
              continue;
            await unclaimed.record({
              installationId: integration.externalId,
              accountLogin:
                typeof integration.config.accountLogin === "string"
                  ? integration.config.accountLogin
                  : integration.displayName,
              accountType:
                typeof integration.config.accountType === "string"
                  ? integration.config.accountType
                  : "Organization",
              source: "sync",
            });
          }
          await erasure.erase({
            name: DELETED_WORKSPACE_NAME,
            slug: `deleted-${workspaceId}`,
          });
          return { ok: true };
        });
      if (result.ok)
        log(`[workspaces] workspace ${workspaceId} was deleted by ${actorId}.`);
      return result;
    },
  };
}
