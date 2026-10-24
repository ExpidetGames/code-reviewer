// SPDX-License-Identifier: LicenseRef-Proprietary

// Changing the members of a workspace (docs/decisions/0001-editions-setup-and-accounts.md, section 2.6):
// giving a member another role, removing one (or leaving), and renaming the workspace. Every function
// decides on its own who may do it, from the role the person has IN THE DATABASE INSIDE THE TRANSACTION that
// makes the change (never from a role read earlier in the request), using the matrix of permissions.ts. So a
// caller that forgets to check anything still cannot hand out a rank, touch an Owner as an Admin, or leave
// a workspace without an Owner, and a person who was removed a moment ago can change nothing.
//
// The last Owner cannot leave, be removed or be demoted. The check counts the Owners and changes the row in
// one transaction that first takes the workspace's lock (`WorkspaceMembersRepository.lock`), so two Owners
// who leave at the same moment cannot both succeed: whichever comes second sees one Owner.
import type { Kysely } from "kysely";
import {
  createWorkspaceMembersRepository,
  type Member,
} from "../db/repositories/workspace-members-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { validateWorkspaceName } from "./names.ts";
import { can, canChangeRole, canRemoveMemberWithRole } from "./permissions.ts";
import { isWorkspaceRole, type WorkspaceRole } from "./roles.ts";

export const MEMBER_ERROR_CODES = [
  /** The person who acts is not a member of the workspace (any more): the workspace is not there for them. */
  "not_found",
  /** The person is a member, and the role they have does not allow this. */
  "forbidden",
  /** The member to change is not in this workspace. */
  "member_not_found",
  /** The change would leave the workspace without an Owner. */
  "last_owner",
  /** The role is not one of owner, admin, member. */
  "invalid_role",
  "invalid_name",
] as const;
export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number];

export const MEMBER_ERROR_STATUS: Record<MemberErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  member_not_found: 404,
  last_owner: 409,
  invalid_role: 422,
  invalid_name: 422,
};

export type MemberResult<T = Record<never, never>> =
  ({ ok: true } & T) | { ok: false; error: MemberErrorCode };

export type MembersService = {
  /** The members of the workspace, in the order they joined. The caller has checked that the person may see them. */
  list(workspaceId: string): Promise<Member[]>;
  /** Gives the member another role. Owners only. `changed` is false when the member had that role already. */
  changeRole(input: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    role: unknown;
  }): Promise<MemberResult<{ changed: boolean }>>;
  /**
   * Takes a member out of the workspace. A person removing themselves is leaving, which every member may
   * do; removing somebody else needs the right over their role (an Owner anybody, an Admin a Member).
   */
  remove(input: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<MemberResult<{ left: boolean }>>;
  /** Renames the workspace. Owners only; the slug (the address) stays. */
  rename(input: {
    workspaceId: string;
    actorId: string;
    name: unknown;
  }): Promise<MemberResult<{ name: string }>>;
};

export function createMembersService({
  db,
  now = () => new Date(),
}: {
  db: Kysely<Database>;
  now?: () => Date;
}): MembersService {
  return {
    list: (workspaceId) =>
      createWorkspaceMembersRepository(db, workspaceId, now).list(),

    async changeRole({ workspaceId, actorId, targetUserId, role }) {
      if (!isWorkspaceRole(role)) return { ok: false, error: "invalid_role" };
      return db.transaction().execute(async (trx) => {
        const members = createWorkspaceMembersRepository(trx, workspaceId, now);
        await members.lock();
        const actor = await members.get(actorId);
        if (actor === undefined) return { ok: false, error: "not_found" };
        if (!canChangeRole(actor.role))
          return { ok: false, error: "forbidden" };

        const target = await members.get(targetUserId);
        if (target === undefined)
          return { ok: false, error: "member_not_found" };
        if (target.role === role) return { ok: true, changed: false };
        if (target.role === "owner" && (await members.countOwners()) <= 1)
          return { ok: false, error: "last_owner" };

        await members.setRole(targetUserId, role);
        return { ok: true, changed: true };
      });
    },

    async remove({ workspaceId, actorId, targetUserId }) {
      return db.transaction().execute(async (trx) => {
        const members = createWorkspaceMembersRepository(trx, workspaceId, now);
        await members.lock();
        const actor = await members.get(actorId);
        if (actor === undefined) return { ok: false, error: "not_found" };

        const leaving = actorId === targetUserId;
        // A Member can only leave; nothing else is theirs to do, whoever the other person is.
        if (!leaving && !canRemoveMemberWithRole(actor.role, "member"))
          return { ok: false, error: "forbidden" };

        const target = leaving ? actor : await members.get(targetUserId);
        if (target === undefined)
          return { ok: false, error: "member_not_found" };
        if (!leaving && !canRemoveMemberWithRole(actor.role, target.role))
          return { ok: false, error: "forbidden" };

        if (target.role === "owner" && (await members.countOwners()) <= 1)
          return { ok: false, error: "last_owner" };

        await members.remove(targetUserId);
        return { ok: true, left: leaving };
      });
    },

    async rename({ workspaceId, actorId, name }) {
      const checked = validateWorkspaceName(name);
      if (!checked.ok) return { ok: false, error: "invalid_name" };
      return db.transaction().execute(async (trx) => {
        const members = createWorkspaceMembersRepository(trx, workspaceId, now);
        await members.lock();
        const actor = await members.get(actorId);
        if (actor === undefined) return { ok: false, error: "not_found" };
        if (!can(actor.role, "rename_workspace"))
          return { ok: false, error: "forbidden" };
        const renamed = await createWorkspacesRepository(trx, now).rename(
          workspaceId,
          checked.name,
        );
        if (!renamed) return { ok: false, error: "not_found" };
        return { ok: true, name: checked.name };
      });
    },
  };
}

/** Roles in the order a list shows them: Owners first. */
export function roleOrder(role: WorkspaceRole): number {
  return { owner: 0, admin: 1, member: 2 }[role];
}
