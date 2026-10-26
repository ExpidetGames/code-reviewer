// SPDX-License-Identifier: LicenseRef-Proprietary

// Creating a workspace and switching the tenancy read the number of workspaces, the slugs and the owner's limit and then
// write, and under Postgres' READ COMMITTED isolation two of them at the same moment can both pass their check. One
// transaction advisory lock in front of both makes them take turns. The namespace is the number of the issue that
// asked for it (#105), like the others (entitlements-lock.ts); keep the pairs unique.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export const WORKSPACE_CREATION_LOCK = { namespace: 105, key: 1 } as const;

export async function lockWorkspaceCreation(
  executor: Kysely<Database>,
): Promise<void> {
  if (!executor.isTransaction)
    throw new Error("The workspace creation lock requires a transaction.");
  await sql`select pg_advisory_xact_lock(${WORKSPACE_CREATION_LOCK.namespace}, ${WORKSPACE_CREATION_LOCK.key})`.execute(
    executor,
  );
}
