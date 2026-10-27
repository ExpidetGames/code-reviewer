// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the invitations of ONE workspace (the table `invitations`, src/workspaces/invitations.ts). Created
// for a workspace like every repository of customer data: a row of another workspace is simply not there.
// Finding an invitation by its token (the person who opens a link does not know the workspace yet) is the
// job of invitation-directory-repository.ts, which only reads; everything that changes a row goes through
// this module and so through the workspace named by what was found.
//
// An invitation is OPEN until it is accepted or revoked; whether an open one has expired is a matter of
// time and is decided by the caller from `expiresAt` (the functions that end or replace an invitation
// check it themselves, in the statement that changes the row).
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { isWorkspaceRole, type WorkspaceRole } from "../workspace-roles.ts";
import type { Database, InvitationsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type Invitation = {
  id: string;
  workspaceId: string;
  /** Canonical (lower case, the domain in punycode). */
  email: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  /** ISO 8601 text in UTC. */
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
};

export function toInvitation(row: Selectable<InvitationsTable>): Invitation {
  if (!isWorkspaceRole(row.role))
    throw new Error(`The database holds an unknown role "${row.role}".`);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at,
  };
}

export type NewInvitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  expiresAt: Date;
};

export type InvitationsRepository = {
  create(input: NewInvitation): Promise<Invitation>;
  get(id: string): Promise<Invitation | undefined>;
  /** The invitations that are neither accepted nor revoked (expired ones included), newest first. */
  listOpen(): Promise<Invitation[]>;
  /** The open invitation for this canonical address, if there is one (expired or not). */
  findOpenByEmail(email: string): Promise<Invitation | undefined>;
  /** Ends the open invitations for this address that have expired; the new one can then be made. */
  revokeExpiredFor(email: string): Promise<number>;
  /** Ends an open invitation. False when it does not exist here or is not open (accepted, revoked). */
  revoke(id: string): Promise<boolean>;
  /**
   * Gives an open invitation a new token and a new expiry, which is what makes the old link stop working.
   * False when it does not exist here or is not open.
   */
  replaceToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean>;
  /**
   * Marks an invitation accepted by the user, in one guarded statement: it only changes an invitation that
   * is open and has not expired, so of two requests with one link only one succeeds.
   */
  markAccepted(id: string, userId: string): Promise<boolean>;
};

export function createInvitationsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): InvitationsRepository {
  const mine = () =>
    db
      .selectFrom("invitations")
      .selectAll()
      .where("workspace_id", "=", workspaceId);

  return {
    async create(input) {
      const row: InvitationsTable = {
        id: input.id,
        workspace_id: workspaceId,
        email: input.email,
        role: input.role,
        token_hash: input.tokenHash,
        invited_by: input.invitedBy,
        created_at: formatTimestamp(now()),
        expires_at: formatTimestamp(input.expiresAt),
        accepted_at: null,
        accepted_by: null,
        revoked_at: null,
      };
      await db.insertInto("invitations").values(row).execute();
      return toInvitation(row);
    },

    async get(id) {
      const row = await mine().where("id", "=", id).executeTakeFirst();
      return row === undefined ? undefined : toInvitation(row);
    },

    async listOpen() {
      const rows = await mine()
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .execute();
      return rows.map(toInvitation);
    },

    async findOpenByEmail(email) {
      const row = await mine()
        .where("email", "=", email)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return row === undefined ? undefined : toInvitation(row);
    },

    async revokeExpiredFor(email) {
      const current = formatTimestamp(now());
      const result = await db
        .updateTable("invitations")
        .set({ revoked_at: current })
        .where("workspace_id", "=", workspaceId)
        .where("email", "=", email)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", "<=", current)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async revoke(id) {
      const result = await db
        .updateTable("invitations")
        .set({ revoked_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async replaceToken(id, tokenHash, expiresAt) {
      const result = await db
        .updateTable("invitations")
        .set({
          token_hash: tokenHash,
          expires_at: formatTimestamp(expiresAt),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markAccepted(id, userId) {
      const current = formatTimestamp(now());
      const result = await db
        .updateTable("invitations")
        .set({ accepted_at: current, accepted_by: userId })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", current)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
