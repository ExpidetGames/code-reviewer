// SPDX-License-Identifier: Apache-2.0

// The person who accepts an invitation, as the database has them right now: whether the address is verified
// is read from the account, never taken from the session or the request.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { Acceptor } from "./invitations.ts";

export async function loadAcceptorFrom(
  db: Kysely<Database>,
  userId: string,
): Promise<Acceptor | null> {
  const row = await db
    .selectFrom("users")
    .select(["id", "email", "email_verified", "is_instance_admin"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified === 1,
    isInstanceAdmin: row.is_instance_admin === 1,
  };
}
