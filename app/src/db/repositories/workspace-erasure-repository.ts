// SPDX-License-Identifier: Apache-2.0

// The deletion of ONE workspace (#658; the factory takes the workspace id, see ../workspace-scope.ts). It is the only
// code that removes a workspace's data as a whole, and every statement filters by that workspace, directly or through
// the repositories and jobs that belong to it. The caller (src/workspaces/delete-workspace.ts) runs it inside one
// transaction, with the repositories created on that transaction, after it has locked the workspace and checked the
// balance; nothing here decides whether a deletion is allowed except the two facts it can read (`hasRunningJobs`,
// `hasOpenPayment`).
//
// What goes and what stays (the reasons are in src/workspaces/README.md, "Deleting a workspace"):
// - goes: the members, invitations, connections (the GitHub installation is released), repositories, projects, jobs with
//   everything that hangs off a job (queue entries, comments, check runs, dispatches, claimed keys, VM runs, usage
//   records, refusal notices), the settings, the stored keys, the entitlements, the hand-over tokens, the link requests
//   and the billing profile, limit and notification state;
// - stays: the `workspaces` row itself, anonymised and marked with `deleted_at`, the billing journal (append-only, the
//   database refuses a delete, and it carries what accountants need: amounts, minutes, provider references), the
//   cached balances and the top-up intents that explain the credit, and the start credit memory (it must keep a deleted
//   workspace from earning the credit twice).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type WorkspaceErasure = {
  /** Whether a job of the workspace holds a lease right now (a runner is working on it). */
  hasRunningJobs(): Promise<boolean>;
  /** Whether a checkout of a top-up was started at or after `since` and has not ended: a payment may still arrive. */
  hasOpenPayment(since: Date): Promise<boolean>;
  /** Removes the data listed above and turns the workspace row into the tombstone. */
  erase(tombstone: { name: string; slug: string }): Promise<void>;
};

export function createWorkspaceErasureRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceErasure {
  const ownJobs = () =>
    db.selectFrom("jobs").select("id").where("workspace_id", "=", workspaceId);
  const ownRepositories = () =>
    db
      .selectFrom("repositories")
      .select("id")
      .where("workspace_id", "=", workspaceId);

  return {
    async hasRunningJobs() {
      const row = await db
        .selectFrom("jobs")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("status", "=", "running")
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async hasOpenPayment(since) {
      const row = await db
        .selectFrom("billing_topup_intents")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "pending")
        .where("created_at", ">=", formatTimestamp(since))
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async erase({ name, slug }) {
      // Everything that hangs off a job first, then the jobs (the foreign keys point from the leaves to the roots).
      await db
        .deleteFrom("job_claimed_keys")
        .where("job_id", "in", ownJobs())
        .execute();
      await db
        .deleteFrom("job_dispatches")
        .where("job_id", "in", ownJobs())
        .execute();
      await db
        .deleteFrom("job_comments")
        .where("job_id", "in", ownJobs())
        .execute();
      for (const table of [
        "job_check_runs",
        "job_vm_runs",
        "usage_records",
        "refusal_notices",
      ] as const)
        await db
          .deleteFrom(table)
          .where("workspace_id", "=", workspaceId)
          .execute();
      // A job may point at the job that superseded it; both are this workspace's and go in one statement.
      await db
        .deleteFrom("jobs")
        .where("workspace_id", "=", workspaceId)
        .execute();

      await db
        .deleteFrom("projects")
        .where("repository_id", "in", ownRepositories())
        .execute();
      await db
        .deleteFrom("repositories")
        .where("workspace_id", "=", workspaceId)
        .execute();
      await db
        .deleteFrom("integrations")
        .where("workspace_id", "=", workspaceId)
        .execute();

      for (const table of [
        "installation_link_requests",
        "invitations",
        "workspace_members",
        "app_settings",
        "workspace_secrets",
        "workspace_entitlements",
        "plan_handoff_tokens",
        "billing_profiles",
        "billing_workspace_settings",
        "billing_notifications",
      ] as const)
        await db
          .deleteFrom(table)
          .where("workspace_id", "=", workspaceId)
          .execute();

      // The tombstone: nobody can find the workspace by its name or address any more, and the address is free again.
      await db
        .updateTable("workspaces")
        .set({
          name,
          slug,
          created_by: null,
        })
        .where("id", "=", workspaceId)
        .execute();
    },
  };
}
