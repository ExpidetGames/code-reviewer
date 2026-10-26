// SPDX-License-Identifier: LicenseRef-Proprietary

// Two people finishing the first-run setup at the same moment must not both get past the check that the setup is still
// open: under Postgres' READ COMMITTED isolation both would read no marker and both would write. A transaction advisory
// lock at the start of the completion makes the second wait and then find the marker the first set. The namespace is
// the number of the issue that introduced the setup (#97), like the others (entitlements-lock.ts); keep the pairs unique.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export const SETUP_COMPLETION_LOCK = { namespace: 97, key: 1 } as const;

export async function lockSetupCompletion(
  executor: Kysely<Database>,
): Promise<void> {
  if (!executor.isTransaction)
    throw new Error("The setup completion lock requires a transaction.");
  await sql`select pg_advisory_xact_lock(${SETUP_COMPLETION_LOCK.namespace}, ${SETUP_COMPLETION_LOCK.key})`.execute(
    executor,
  );
}
