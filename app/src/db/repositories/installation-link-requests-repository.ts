// SPDX-License-Identifier: Apache-2.0

// Access to the requests of ONE workspace to link an installation that the instance admin decides
// (src/installation-binding/requests.ts). The factory takes the workspace id; see ../workspace-scope.ts. The
// instance admin reads and decides the requests of every workspace through
// installation-link-request-directory-repository.ts.
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  LINK_REQUEST_STATUSES,
  isRoleResult,
  type InstallationLinkRequest,
  type NewInstallationLinkRequest,
} from "../../installation-binding/requests.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database, InstallationLinkRequestsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type InstallationLinkRequestsRepository = {
  /**
   * Records that the person asks for the installation to be linked. A request for the same installation that
   * waits already is refreshed (the newest evidence and requester) instead of a second one being made, so the
   * admin sees one line per installation.
   */
  createPending(
    input: NewInstallationLinkRequest,
  ): Promise<InstallationLinkRequest>;
  get(id: string): Promise<InstallationLinkRequest | undefined>;
  /** The pending request for this installation, if there is one. */
  findPending(
    installationId: string,
  ): Promise<InstallationLinkRequest | undefined>;
  /** The newest requests of the workspace, newest first. */
  list(limit?: number): Promise<InstallationLinkRequest[]>;
  /** Ends the pending requests for the installation because it was linked in the meantime. */
  withdrawPending(installationId: string): Promise<void>;
};

export function toLinkRequest(
  row: InstallationLinkRequestsTable,
): InstallationLinkRequest {
  const status = LINK_REQUEST_STATUSES.find((value) => value === row.status);
  if (status === undefined)
    throw new Error(`Stored request ${row.id} has an unknown status.`);
  if (!isRoleResult(row.role_result))
    throw new Error(`Stored request ${row.id} has an unknown role result.`);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by,
    requesterGithubLogin: row.requester_github_login,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    accountId: row.account_id,
    status,
    evidence: {
      tokenCanAccess:
        row.token_can_access === null ? null : row.token_can_access === 1,
      roleResult: row.role_result,
      roleDetail: row.role_detail,
    },
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function createInstallationLinkRequestsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): InstallationLinkRequestsRepository {
  async function findPending(installationId: string) {
    const row = await db
      .selectFrom("installation_link_requests")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("installation_id", "=", installationId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return row === undefined ? undefined : toLinkRequest(row);
  }

  return {
    async createPending(input) {
      const values = {
        requested_by: input.requestedBy,
        requester_github_login: input.requesterGithubLogin,
        account_login: input.accountLogin,
        account_type: input.accountType,
        account_id: input.accountId,
        token_can_access:
          input.evidence.tokenCanAccess === null
            ? null
            : input.evidence.tokenCanAccess
              ? 1
              : 0,
        role_result: input.evidence.roleResult,
        role_detail: input.evidence.roleDetail,
        created_at: formatTimestamp(now()),
      };
      // The partial unique index decides a race between two requests: one row per pending installation.
      const row = await db
        .insertInto("installation_link_requests")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          installation_id: input.installationId,
          status: "pending",
          decided_at: null,
          decided_by: null,
          ...values,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["workspace_id", "installation_id"])
            // Written like the predicate of the index (a bound value would not match it).
            .where(sql<boolean>`status = 'pending'`)
            .doUpdateSet(values),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toLinkRequest(row);
    },

    async get(id) {
      const row = await db
        .selectFrom("installation_link_requests")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toLinkRequest(row);
    },

    findPending,

    async list(limit = 20) {
      const rows = await db
        .selectFrom("installation_link_requests")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map(toLinkRequest);
    },

    async withdrawPending(installationId) {
      await db
        .updateTable("installation_link_requests")
        .set({ status: "withdrawn", decided_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("installation_id", "=", installationId)
        .where("status", "=", "pending")
        .execute();
    },
  };
}
