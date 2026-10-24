// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing settings live in one JSON setting that holds the switch and the rates, and a writer reads it, changes a
// field and writes it back. A transaction advisory lock makes that read-modify-write one step on Postgres, so two writers
// (the rates, the switch of #504) cannot lose each other's change (SQLite's transactions take the write lock up front,
// see dialect.ts). The namespace is the number of the issue that introduced it; keep the pairs unique.
import "server-only";
import { sql, type Kysely } from "kysely";
import { databaseDriver } from "./driver.ts";
import type { Database } from "./schema.ts";

export const BILLING_SETTINGS_LOCK = { namespace: 494, key: 1 } as const;

export async function lockBillingSettings(
  executor: Kysely<Database>,
): Promise<void> {
  if (databaseDriver(executor) !== "postgres") return;
  if (!executor.isTransaction)
    throw new Error("The billing settings lock requires a transaction.");
  await sql`select pg_advisory_xact_lock(${BILLING_SETTINGS_LOCK.namespace}, ${BILLING_SETTINGS_LOCK.key})`.execute(
    executor,
  );
}
