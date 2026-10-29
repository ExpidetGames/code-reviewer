// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the workspace pages make to the app's own routes (src/workspaces/http.ts): rename, change a
// role, remove a member or leave, invite, revoke, resend, create a workspace, accept an invitation. The
// workspace is the one of the page that makes the call. Browser side; no secrets here (an invitation link
// is in an answer, shown once to the person who asked for it).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { InvitationDelivery, OpenInvitation } from "../invitations.ts";
import { workspaceApiPath } from "../paths.ts";
import type { WorkspaceRole } from "../../db/workspace-roles.ts";

export type InviteAnswer = {
  ok: true;
  invitation: OpenInvitation;
  delivery: InvitationDelivery;
};

export type AcceptAnswer = {
  ok: true;
  workspace: { slug: string; name: string };
  role: WorkspaceRole;
  alreadyMember: boolean;
};

export type WorkspaceApi = {
  rename(name: string): Promise<RequestResult<{ ok: true; name: string }>>;
  /** Deletes the workspace; the name is the one the person typed. */
  deleteWorkspace(confirmName: string): Promise<RequestResult<{ ok: true }>>;
  changeRole(
    userId: string,
    role: WorkspaceRole,
  ): Promise<RequestResult<{ ok: true; changed: boolean }>>;
  removeMember(
    userId: string,
  ): Promise<RequestResult<{ ok: true; left: boolean }>>;
  invite(
    email: string,
    role: WorkspaceRole,
  ): Promise<RequestResult<InviteAnswer>>;
  revokeInvitation(id: string): Promise<RequestResult<{ ok: true }>>;
  resendInvitation(id: string): Promise<RequestResult<InviteAnswer>>;
};

export function createWorkspaceApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): WorkspaceApi {
  const path = (rest = "") => workspaceApiPath(workspaceSlug, rest);
  const member = (userId: string) =>
    path(`/members/${encodeURIComponent(userId)}`);
  const invitation = (id: string) =>
    path(`/invitations/${encodeURIComponent(id)}`);
  return {
    rename: (name) => requestJson(fetchImpl, "PATCH", path(), { name }),
    deleteWorkspace: (confirmName) =>
      requestJson(fetchImpl, "DELETE", path(), { confirmName }),
    changeRole: (userId, role) =>
      requestJson(fetchImpl, "PATCH", member(userId), { role }),
    removeMember: (userId) => requestJson(fetchImpl, "DELETE", member(userId)),
    invite: (email, role) =>
      requestJson(fetchImpl, "POST", path("/invitations"), { email, role }),
    revokeInvitation: (id) => requestJson(fetchImpl, "DELETE", invitation(id)),
    resendInvitation: (id) =>
      requestJson(fetchImpl, "POST", `${invitation(id)}/resend`),
  };
}

export function browserWorkspaceApi(workspaceSlug: string): WorkspaceApi {
  return createWorkspaceApi((url, init) => fetch(url, init), workspaceSlug);
}

/** The calls that are not about one workspace. */
export type AccountApi = {
  createWorkspace(
    name: string,
  ): Promise<
    RequestResult<{ ok: true; workspace: { slug: string; name: string } }>
  >;
  accept(
    which: { token: string } | { invitationId: string },
  ): Promise<RequestResult<AcceptAnswer>>;
};

export function createAccountApi(fetchImpl: FetchLike): AccountApi {
  return {
    createWorkspace: (name) =>
      requestJson(fetchImpl, "POST", "/api/workspaces", { name }),
    accept: (which) =>
      requestJson(fetchImpl, "POST", "/api/invitations/accept", which),
  };
}

export const browserAccountApi: AccountApi = createAccountApi((url, init) =>
  fetch(url, init),
);
