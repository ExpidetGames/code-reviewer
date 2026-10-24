// SPDX-License-Identifier: LicenseRef-Proprietary

// The default entitlements of the instance live in one JSON setting, so there may be no row to lock when two
// writers set the period start at the same time. A transaction advisory lock covers that case on Postgres
// (SQLite's transactions take the write lock up front, see dialect.ts). The namespace is the number of the
// issue that introduced it, like the Dynamic gate's 195 (dynamic-review-lock.ts); keep the pairs unique.
import "server-only";
import { sql, type Kysely } from "kysely";
import { databaseDriver } from "./driver.ts";
import type { Database } from "./schema.ts";

export const DEFAULT_ENTITLEMENTS_LOCK = { namespace: 271, key: 1 } as const;

export async function lockDefaultEntitlements(
  executor: Kysely<Database>,
): Promise<void> {
  if (databaseDriver(executor) !== "postgres") return;
  if (!executor.isTransaction)
    throw new Error("The default entitlements lock requires a transaction.");
  await sql`select pg_advisory_xact_lock(${DEFAULT_ENTITLEMENTS_LOCK.namespace}, ${DEFAULT_ENTITLEMENTS_LOCK.key})`.execute(
    executor,
  );
}
