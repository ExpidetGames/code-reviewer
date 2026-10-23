// SPDX-License-Identifier: Apache-2.0

// Deleting a workspace (#658). One transaction, decided from the database inside it (like every change of the members,
// src/workspaces/members.ts), so a caller that forgets a check still cannot delete: the person must be an Owner of this
// workspace right now, must have typed its name, and the workspace must be in a state that can end safely.
//
// Refused, with a stable code (the data stays exactly as it was):
// - `forbidden` / `not_found`: not an Owner / not a member (any more), or the workspace is deleted already;
// - `name_mismatch`: the typed name is not the workspace's name (exact, after trimming the ends);
// - `balance_positive` / `balance_negative`: the balance is not exactly zero. Unused prepaid credit would be destroyed (it is
//   paid out by support, not by a deletion), and an open amount would be forgiven; either waits until it is settled;
// - `review_running`: a review is running, or a superseded run still drains. It would report to a workspace that is gone, so
//   the person tries again when it has finished;
// - `payment_open`: a top-up checkout was started within the window a late payment is still credited in
//   (`PENDING_TOP_UP_WINDOW_MS`) and has no end yet (`paid`, `failed`), so a payment may still arrive: it would credit nobody.
//
// The locks, in the order every writer of the queue uses (Postgres; SQLite has one writer): the Dynamic gate, shared (a claim
// holds it exclusively from its start to its commit, so a claim in flight is waited for, and a claim that starts later waits
// for this deletion); the workspace row (the members, like every writer that follows); the repositories and the waiting,
// running and superseded jobs of the workspace (`lockActiveJobs`); the balance row last (a top-up, a claim or a charge cannot
// slip in between the check and the deletion). A claim takes the gate, then its job row, the workspace row, the balance row:
// the same order, so the two cannot wait for each other.
//
// What happens otherwise: the GitHub installations of the workspace are released (the connection rows go, and each
// installation, disconnected or not, is noted as unclaimed so another workspace, or this person's next one, can link it
// again; nothing is sent to GitHub, the App stays installed there until the person removes it), and the repository
// `WorkspaceErasure` removes the data and turns the row into the tombstone. The journal and the money records stay: see
// `workspace-erasure-repository.ts`. After the commit the check runs of the waiting reviews are completed on GitHub, best
// effort (`finish-checks.ts`).
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createWorkspaceErasureRepository } from "../db/repositories/workspace-erasure-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import {
  createWorkspacesRepository,
  deletedWorkspaceSlug,
} from "../db/repositories/workspaces-repository.ts";
import { lockDynamicReviewGate } from "../db/dynamic-review-lock.ts";
import type { Database } from "../db/schema.ts";
import { PENDING_TOP_UP_WINDOW_MS } from "../billing/topup-intent.ts";
import { can } from "./permissions.ts";
import type { CheckFinisher, ChecksToFinish } from "./finish-checks.ts";

export const DELETE_WORKSPACE_ERROR_CODES = [
  "not_found",
  "forbidden",
  "name_mismatch",
  "balance_positive",
  "balance_negative",
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
  balance_negative: 409,
  review_running: 409,
  payment_open: 409,
};

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
  finishChecks,
}: {
  db: Kysely<Database>;
  now?: () => Date;
  log?: (message: string) => void;
  /** Completes the check runs of the waiting reviews after the commit; absent where no platform is connected (tests). */
  finishChecks?: CheckFinisher;
}): WorkspaceDeletion {
  return {
    async delete({ workspaceId, actorId, confirmName }) {
      let released: ChecksToFinish | undefined;
      const result = await db
        .transaction()
        .execute(async (trx): Promise<DeleteWorkspaceResult> => {
          // Before any row: a claim in flight is waited for, and none starts until this deletion has ended.
          await lockDynamicReviewGate(trx, false);
          const members = createWorkspaceMembersRepository(
            trx,
            workspaceId,
            now,
          );
          // The workspace row, like every writer that follows (members, claims): one at a time.
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

          const erasure = createWorkspaceErasureRepository(trx, workspaceId);
          await erasure.lockActiveJobs();
          const journal = createBillingJournalRepository(trx, workspaceId, now);
          await journal.lockBalance();
          const balance = await journal.balance();
          if (balance.balanceMicroUsd > 0)
            return { ok: false, error: "balance_positive" };
          if (balance.balanceMicroUsd < 0)
            return { ok: false, error: "balance_negative" };
          if (
            balance.reservedMicroUsd > 0 ||
            (await erasure.hasRunningJobs(now()))
          )
            return { ok: false, error: "review_running" };
          if (
            await erasure.hasOpenPayment(
              new Date(now().getTime() - PENDING_TOP_UP_WINDOW_MS),
            )
          )
            return { ok: false, error: "payment_open" };

          const integrations = await createIntegrationsRepository(
            trx,
            workspaceId,
            now,
          ).list();
          const checks = await erasure.openChecks();
          const unclaimed = createUnclaimedInstallationsRepository(trx, now);
          for (const integration of integrations) {
            if (integration.type !== "github_app") continue;
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
            slug: deletedWorkspaceSlug(workspaceId),
            deletedAt: now(),
          });
          released = { workspaceId, integrations, checks };
          return { ok: true };
        });
      if (!result.ok) return result;
      log(`[workspaces] workspace ${workspaceId} was deleted by ${actorId}.`);
      // The deletion stands whatever happens to the check runs: nothing here can fail it.
      if (finishChecks !== undefined && released !== undefined)
        await finishChecks(released).catch((error: unknown) => {
          log(
            `[workspaces] CHECK_RUN_NOT_COMPLETED workspace ${workspaceId}: ${error instanceof Error ? error.name : "error"}`,
          );
        });
      return result;
    },
  };
}
