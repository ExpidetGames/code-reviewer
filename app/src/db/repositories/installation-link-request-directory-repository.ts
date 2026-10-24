// SPDX-License-Identifier: LicenseRef-Proprietary

// The requests to link an installation seen from outside every workspace, for the instance admin who decides
// them (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.3 and 2.9). INSTANCE LEVEL, on purpose:
// the admin sees the requests of all workspaces in one list. Reading carries the workspace and requester names;
// the only write is the decision, which is one guarded statement that works on a request that still waits.
// Requesting and withdrawing are the job of the scoped repository (installation-link-requests-repository.ts).
import "server-only";
import type { Kysely } from "kysely";
import type {
  InstallationLinkRequest,
  InstallationLinkRequestView,
} from "../../installation-binding/requests.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import { toLinkRequest } from "./installation-link-requests-repository.ts";
import { NOT_DELETED } from "./workspaces-repository.ts";

export type InstallationLinkRequestDirectory = {
  /** One request of any workspace, with the names the admin needs. */
  get(id: string): Promise<InstallationLinkRequestView | undefined>;
  /** The requests that still wait, oldest first. */
  listPending(): Promise<InstallationLinkRequestView[]>;
  /** The newest decided requests, newest decision first. */
  listDecided(limit?: number): Promise<InstallationLinkRequestView[]>;
  countPending(): Promise<number>;
  /**
   * Ends a request that waits with the decision of the admin. Returns the request, or undefined when it does not
   * wait any more (decided, withdrawn or never there): a request is decided once.
   */
  decide(
    id: string,
    decision: { status: "approved" | "denied"; decidedBy: string },
  ): Promise<InstallationLinkRequest | undefined>;
  /**
   * Ends the requests of EVERY workspace that still wait for the installation, because it belongs to a
   * workspace now: a request that can never be approved must not wait forever. Returns how many were ended.
   */
  withdrawPendingFor(installationId: string): Promise<number>;
};

export function createInstallationLinkRequestDirectory(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InstallationLinkRequestDirectory {
  function views() {
    return db
      .selectFrom("installation_link_requests")
      .innerJoin(
        "workspaces",
        "workspaces.id",
        "installation_link_requests.workspace_id",
      )
      .leftJoin("users", "users.id", "installation_link_requests.requested_by")
      .selectAll("installation_link_requests")
      .select([
        "workspaces.name as workspace_name",
        "workspaces.slug as workspace_slug",
        "users.name as requester_name",
        "users.email as requester_email",
      ])
      .where(NOT_DELETED);
  }
  type Row = Awaited<ReturnType<ReturnType<typeof views>["execute"]>>[number];
  const toView = (row: Row): InstallationLinkRequestView => ({
    ...toLinkRequest(row),
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
  });

  return {
    async get(id) {
      const row = await views()
        .where("installation_link_requests.id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toView(row);
    },

    async listPending() {
      const rows = await views()
        .where("installation_link_requests.status", "=", "pending")
        .orderBy("installation_link_requests.created_at")
        .orderBy("installation_link_requests.id")
        .execute();
      return rows.map(toView);
    },

    async listDecided(limit = 20) {
      const rows = await views()
        .where("installation_link_requests.status", "in", [
          "approved",
          "denied",
        ])
        .orderBy("installation_link_requests.decided_at", "desc")
        .orderBy("installation_link_requests.id")
        .limit(limit)
        .execute();
      return rows.map(toView);
    },

    async countPending() {
      const row = await db
        .selectFrom("installation_link_requests")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async decide(id, decision) {
      const row = await db
        .updateTable("installation_link_requests")
        .set({
          status: decision.status,
          decided_at: formatTimestamp(now()),
          decided_by: decision.decidedBy,
        })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toLinkRequest(row);
    },

    async withdrawPendingFor(installationId) {
      const rows = await db
        .updateTable("installation_link_requests")
        .set({ status: "withdrawn", decided_at: formatTimestamp(now()) })
        .where("installation_id", "=", installationId)
        .where("status", "=", "pending")
        .returning("id")
        .execute();
      return rows.length;
    },
  };
}
