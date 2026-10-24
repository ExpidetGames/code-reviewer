// SPDX-License-Identifier: LicenseRef-Proprietary

// The instance gate may have no row yet. A transaction advisory lock covers that case too:
// Lock order: gate first, then a workspace-scoped repository/project (when needed), then jobs by id.
// Enqueue/settings share the gate; gate changes and runner mutations take it exclusively. No lock
// upgrade is allowed after a row lock. All locks last through the short database transaction.
import "server-only";
import { sql, type Kysely, type SelectQueryBuilder } from "kysely";
import { databaseDriver } from "./driver.ts";
import type { Database } from "./schema.ts";

export async function lockDynamicReviewGate(
  executor: Kysely<Database>,
  exclusive: boolean,
): Promise<void> {
  if (databaseDriver(executor) !== "postgres") return;
  if (!executor.isTransaction)
    throw new Error("The Dynamic gate lock requires a transaction.");
  // Reserved application advisory-lock namespace and gate id, identical across app instances.
  if (exclusive)
    await sql`select pg_advisory_xact_lock(195, 1)`.execute(executor);
  else await sql`select pg_advisory_xact_lock_shared(195, 1)`.execute(executor);
}

/** Lock a multi-row transition's complete candidate set before any update, in ascending job id. */
export async function lockJobRowsInOrder(
  executor: Kysely<Database>,
  candidates: SelectQueryBuilder<Database, "jobs", { id: string }>,
): Promise<void> {
  if (databaseDriver(executor) !== "postgres") return;
  await candidates.orderBy("id").forUpdate().execute();
}
