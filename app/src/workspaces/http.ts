// SPDX-License-Identifier: Apache-2.0

// The handlers behind the routes of workspaces, members and invitations, with their collaborators passed in
// so the route files only wire the real ones and tests wire the real services over a test database:
//
//   PATCH  /api/w/:workspace                                 { name }            rename (Owner)
//   DELETE /api/w/:workspace                                 { confirmName }     delete the workspace (Owner)
//   PATCH  /api/w/:workspace/members/:userId                 { role }            change a role (Owner)
//   DELETE /api/w/:workspace/members/:userId                                     remove a member, or leave
//   POST   /api/w/:workspace/invitations                     { email, role }     invite
//   DELETE /api/w/:workspace/invitations/:id                                     revoke
//   POST   /api/w/:workspace/invitations/:id/resend                              a new link (mail server only)
//   POST   /api/workspaces                                   { name }            create a workspace (multi-tenant)
//   POST   /api/invitations/accept                           { token } | { invitationId }
//
// Who is asking and in which workspace is settled before these run (src/workspaces/access-runtime.ts); what
// the role allows is decided by the services themselves, from the database, inside the transaction that
// makes the change. These handlers read the request the one way every JSON route of the app does
// (src/http/json-body.ts): same site, `application/json` only, a small limit, read and parsed once. Every
// refusal is `{ "error": <code> }` with a stable code, `Cache-Control: no-store` (an answer can hold an
// invitation link) and, for a limit, `Retry-After`.
import type { SessionUser } from "../auth/access-policy.ts";
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "./access.ts";
import type { CreateWorkspaceResult } from "./create-workspace.ts";
import {
  DELETE_WORKSPACE_ERROR_STATUS,
  type DeleteWorkspaceErrorCode,
  type WorkspaceDeletion,
} from "./delete-workspace.ts";
import {
  INVITATION_ERROR_STATUS,
  type Acceptor,
  type InvitationErrorCode,
  type InvitationService,
} from "./invitations.ts";
import {
  MEMBER_ERROR_STATUS,
  type MemberErrorCode,
  type MembersService,
} from "./members.ts";

/** A name, an address and a role, or a token: a few hundred bytes. */
export const WORKSPACE_REQUEST_MAX_BYTES = 4 * 1024;

const NO_STORE = { "cache-control": "no-store" };

export const CREATE_WORKSPACE_ERROR_STATUS = {
  multi_tenant_required: 409,
  workspace_limit_reached: 409,
  invalid_name: 422,
  rate_limited: 429,
} as const;

type RefusalCode =
  | JsonBodyErrorCode
  | MemberErrorCode
  | InvitationErrorCode
  | keyof typeof CREATE_WORKSPACE_ERROR_STATUS
  | DeleteWorkspaceErrorCode
  | "invalid_request";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  ...MEMBER_ERROR_STATUS,
  ...INVITATION_ERROR_STATUS,
  ...CREATE_WORKSPACE_ERROR_STATUS,
  ...DELETE_WORKSPACE_ERROR_STATUS,
  invalid_request: 422,
};

function refusal(
  code: RefusalCode,
  extra: { retryAfterSeconds?: number } = {},
): Response {
  return Response.json(
    { error: code },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(extra.retryAfterSeconds) }),
      },
    },
  );
}

function done(body: object): Response {
  return Response.json(body, { headers: NO_STORE });
}

export type WorkspaceRouteDependencies = {
  members: MembersService;
  invitations: InvitationService;
  deletion: WorkspaceDeletion;
  /** Creates a workspace for the user (src/workspaces/create-workspace.ts) after the person's limit. */
  createWorkspace: (input: {
    name: string;
    creatorId: string;
  }) => Promise<
    | CreateWorkspaceResult
    | { ok: false; error: "rate_limited"; retryAfterSeconds: number }
  >;
  /** The acceptor as the database has it now (address, whether it is verified), or null for a deleted user. */
  loadAcceptor: (userId: string) => Promise<Acceptor | null>;
};

export type WorkspaceRouteHandlers = {
  rename(request: Request, access: WorkspaceAccess): Promise<Response>;
  deleteWorkspace(request: Request, access: WorkspaceAccess): Promise<Response>;
  changeRole(
    request: Request,
    access: WorkspaceAccess,
    targetUserId: string,
  ): Promise<Response>;
  removeMember(
    request: Request,
    access: WorkspaceAccess,
    targetUserId: string,
  ): Promise<Response>;
  invite(request: Request, access: WorkspaceAccess): Promise<Response>;
  revokeInvitation(
    request: Request,
    access: WorkspaceAccess,
    invitationId: string,
  ): Promise<Response>;
  resendInvitation(
    request: Request,
    access: WorkspaceAccess,
    invitationId: string,
  ): Promise<Response>;
  create(request: Request, user: SessionUser): Promise<Response>;
  accept(request: Request, user: SessionUser): Promise<Response>;
};

/** The name to put in front of an invitation: the account's display name, or its address. */
function inviterName(user: SessionUser): string {
  return user.name.trim() !== "" ? user.name : user.email;
}

export function createWorkspaceRouteHandlers({
  members,
  invitations,
  deletion,
  createWorkspace,
  loadAcceptor,
}: WorkspaceRouteDependencies): WorkspaceRouteHandlers {
  return {
    async rename(request, access) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await members.rename({
        workspaceId: access.workspace.id,
        actorId: access.user.id,
        name: body.value.name,
      });
      return result.ok
        ? done({ ok: true, name: result.name })
        : refusal(result.error);
    },

    async deleteWorkspace(request, access) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await deletion.delete({
        workspaceId: access.workspace.id,
        actorId: access.user.id,
        confirmName: body.value.confirmName,
      });
      return result.ok ? done({ ok: true }) : refusal(result.error);
    },

    async changeRole(request, access, targetUserId) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await members.changeRole({
        workspaceId: access.workspace.id,
        actorId: access.user.id,
        targetUserId,
        role: body.value.role,
      });
      return result.ok
        ? done({ ok: true, changed: result.changed })
        : refusal(result.error);
    },

    async removeMember(request, access, targetUserId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      const result = await members.remove({
        workspaceId: access.workspace.id,
        actorId: access.user.id,
        targetUserId,
      });
      return result.ok
        ? done({ ok: true, left: result.left })
        : refusal(result.error);
    },

    async invite(request, access) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await invitations.create({
        workspaceId: access.workspace.id,
        workspaceName: access.workspace.name,
        actorId: access.user.id,
        inviterName: inviterName(access.user),
        email: body.value.email,
        role: body.value.role,
      });
      if (!result.ok)
        return refusal(result.error, {
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
        });
      return done({
        ok: true,
        invitation: result.invitation,
        delivery: result.delivery,
      });
    },

    async revokeInvitation(request, access, invitationId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      const result = await invitations.revoke({
        workspaceId: access.workspace.id,
        actorId: access.user.id,
        invitationId,
      });
      return result.ok ? done({ ok: true }) : refusal(result.error);
    },

    async resendInvitation(request, access, invitationId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      const result = await invitations.resend({
        workspaceId: access.workspace.id,
        workspaceName: access.workspace.name,
        actorId: access.user.id,
        inviterName: inviterName(access.user),
        invitationId,
      });
      if (!result.ok)
        return refusal(result.error, {
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
        });
      return done({
        ok: true,
        invitation: result.invitation,
        delivery: result.delivery,
      });
    },

    async create(request, user) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await createWorkspace({
        name: typeof body.value.name === "string" ? body.value.name : "",
        creatorId: user.id,
      });
      if (!result.ok)
        return refusal(
          result.error,
          "retryAfterSeconds" in result
            ? { retryAfterSeconds: result.retryAfterSeconds }
            : {},
        );
      return done({
        ok: true,
        workspace: { slug: result.workspace.slug, name: result.workspace.name },
      });
    },

    async accept(request, user) {
      const body = await readJsonObject(request, WORKSPACE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const { token, invitationId } = body.value;
      // Exactly one way in: the link, or an invitation from the list.
      if ((token === undefined) === (invitationId === undefined))
        return refusal("invalid_request");
      const acceptor = await loadAcceptor(user.id);
      if (acceptor === null) return refusal("invitation_not_found");
      const result = await invitations.accept(
        token !== undefined ? { token } : { invitationId },
        acceptor,
      );
      if (!result.ok)
        return refusal(result.error, {
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
        });
      return done({
        ok: true,
        workspace: result.workspace,
        role: result.role,
        alreadyMember: result.alreadyMember,
      });
    },
  };
}
