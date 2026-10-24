// SPDX-License-Identifier: Apache-2.0

// Finds invitations of ANY workspace, for the two questions that start before the workspace is known: "what
// does this link belong to?" (the person who opens it only holds the token) and "which invitations wait for
// this address?" (the list after sign-in, with a mail server). It only reads, and every answer carries the
// workspace; whatever is done next (accepting, revoking) goes through the scoped repository of that
// workspace (invitations-repository.ts). Same role as integration-directory-repository.ts for webhooks.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import { toInvitation, type Invitation } from "./invitations-repository.ts";
import { NOT_DELETED } from "./workspaces-repository.ts";

/** An invitation with the name of the workspace it is for (shown to the person who holds it). */
export type InvitationWithWorkspace = Invitation & {
  workspaceName: string;
  workspaceSlug: string;
};

export type InvitationDirectory = {
  /** The invitation whose token has this SHA-256 hash (hex), in any state. */
  findByTokenHash(
    tokenHash: string,
  ): Promise<InvitationWithWorkspace | undefined>;
  /** The invitation with this id, in any state. */
  findById(id: string): Promise<InvitationWithWorkspace | undefined>;
  /** The open invitations for this canonical address that have not expired, newest first. */
  listOpenForEmail(email: string): Promise<InvitationWithWorkspace[]>;
};

export function createInvitationDirectory(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InvitationDirectory {
  function invitations() {
    return db
      .selectFrom("invitations")
      .innerJoin("workspaces", "workspaces.id", "invitations.workspace_id")
      .selectAll("invitations")
      .select([
        "workspaces.name as workspace_name",
        "workspaces.slug as workspace_slug",
      ])
      .where(NOT_DELETED);
  }
  type Row = Awaited<ReturnType<ReturnType<typeof invitations>["execute"]>>[0];
  const toWithWorkspace = (row: Row): InvitationWithWorkspace => ({
    ...toInvitation(row),
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
  });

  return {
    async findByTokenHash(tokenHash) {
      const row = await invitations()
        .where("invitations.token_hash", "=", tokenHash)
        .executeTakeFirst();
      return row === undefined ? undefined : toWithWorkspace(row);
    },

    async findById(id) {
      const row = await invitations()
        .where("invitations.id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toWithWorkspace(row);
    },

    async listOpenForEmail(email) {
      const rows = await invitations()
        .where("invitations.email", "=", email)
        .where("invitations.accepted_at", "is", null)
        .where("invitations.revoked_at", "is", null)
        .where("invitations.expires_at", ">", formatTimestamp(now()))
        .orderBy("invitations.created_at", "desc")
        .orderBy("invitations.id")
        .execute();
      return rows.map(toWithWorkspace);
    },
  };
}
