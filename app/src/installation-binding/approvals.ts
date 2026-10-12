// SPDX-License-Identifier: Apache-2.0

// The instance admin's side of the binding (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.3 and
// 2.9): a request exists when a person asked to link an installation and the role of their GitHub account in the
// installation's organization could not be read, so nothing was linked. The admin sees who asked, which
// account the installation is on and the evidence (whether the person's token lists the installation, and the
// result of the role read), and approves or denies.
//
// - Approving links the installation to the requesting workspace, with the same checks the direct way has
//   after the role: the person must still be an Owner or Admin of the workspace, and the installation must not
//   belong to another workspace (it may have been linked in the meantime). The decision and the link are one
//   transaction: a request is decided once, and approved means linked.
// - Denying links nothing. Either way the requester finds the decision in their workspace's list of requests.
import type { Kysely } from "kysely";
import { createInstallationLinkRequestDirectory } from "../db/repositories/installation-link-request-directory-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import type { Connections } from "./connections.ts";
import type { ApprovalErrorCode } from "./errors.ts";
import type { InstallationLinkRequestView } from "./requests.ts";

export type ApprovalResult =
  | { ok: true }
  | {
      ok: false;
      error: Extract<
        ApprovalErrorCode,
        | "request_not_found"
        | "request_not_pending"
        | "requester_not_admin"
        | "installation_already_linked"
        | "installation_not_accessible"
        | "github_unreachable"
        | "unavailable"
      >;
    };

export type ApprovalService = {
  /** The requests that wait (oldest first) and the ones decided last (newest first). */
  list(): Promise<{
    pending: InstallationLinkRequestView[];
    decided: InstallationLinkRequestView[];
  }>;
  approve(adminId: string, requestId: string): Promise<ApprovalResult>;
  deny(adminId: string, requestId: string): Promise<ApprovalResult>;
};

export function createApprovalService({
  db,
  connections,
  now,
}: {
  db: Kysely<Database>;
  connections: Connections;
  now?: () => Date;
}): ApprovalService {
  const directory = createInstallationLinkRequestDirectory(db, now);
  const workspaces = createWorkspacesRepository(db, now);

  return {
    async list() {
      return {
        pending: await directory.listPending(),
        decided: await directory.listDecided(),
      };
    },

    async approve(adminId, requestId) {
      const request = await directory.get(requestId);
      if (request === undefined)
        return { ok: false, error: "request_not_found" };
      if (request.status !== "pending")
        return { ok: false, error: "request_not_pending" };
      // The person must still be allowed to connect GitHub in that workspace.
      const membership =
        request.requestedBy === null
          ? undefined
          : await workspaces.findMembershipById(
              request.requestedBy,
              request.workspaceId,
            );
      if (
        membership === undefined ||
        !can(membership.role, "manage_connections")
      )
        return { ok: false, error: "requester_not_admin" };

      const linked = await connections.link({
        workspaceId: request.workspaceId,
        installationId: request.installationId,
        // The decision is claimed inside the transaction of the link: both happen, or neither.
        claim: async (trx) =>
          (await createInstallationLinkRequestDirectory(trx, now).decide(
            requestId,
            { status: "approved", decidedBy: adminId },
          )) !== undefined,
      });
      if (linked.ok) return { ok: true };
      if (linked.error === "not_claimed")
        return { ok: false, error: "request_not_pending" };
      // Linked to another workspace in the meantime: the request can never be approved, so it must not wait
      // (and be tried again) forever. The admin is told, and finds it among the ended ones.
      if (linked.error === "installation_already_linked")
        await directory.withdrawPendingFor(request.installationId);
      return { ok: false, error: linked.error };
    },

    async deny(adminId, requestId) {
      const request = await directory.get(requestId);
      if (request === undefined)
        return { ok: false, error: "request_not_found" };
      const decided = await directory.decide(requestId, {
        status: "denied",
        decidedBy: adminId,
      });
      return decided === undefined
        ? { ok: false, error: "request_not_pending" }
        : { ok: true };
    },
  };
}
