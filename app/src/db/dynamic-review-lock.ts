// SPDX-License-Identifier: Apache-2.0

// The instance gate may have no row yet. A transaction advisory lock covers that case too:
// enqueues share it; gate writes/removal take it exclusively through their drain commit.
import "server-only";
import { sql, type Kysely } from "kysely";
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
