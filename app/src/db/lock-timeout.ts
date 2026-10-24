// SPDX-License-Identifier: LicenseRef-Proprietary

// A bounded wait for a row lock on Postgres. A write that must not run beside the daily models.dev fetch reads the
// provider's row `FOR UPDATE` first, the lock the fetch holds while it writes (#548); without a bound it would wait for
// as long as the fetch does. On SQLite every transaction begins `begin immediate`, so there is nothing to set.
import { sql, type Kysely } from "kysely";
import { databaseDriver } from "./driver.ts";
import type { Database } from "./schema.ts";

/** Postgres' error code for a lock that could not be taken within `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** Limits the waits of the current transaction for a lock. The number is an integer made here, never text of a request. */
export async function setLockTimeout(
  trx: Kysely<Database>,
  milliseconds: number,
): Promise<void> {
  if (databaseDriver(trx) !== "postgres") return;
  await sql
    .raw(
      `set local lock_timeout = ${String(Math.max(1, Math.floor(milliseconds)))}`,
    )
    .execute(trx);
}

/** Whether a database error is a lock that could not be taken within the time `setLockTimeout` allowed. */
export function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === LOCK_NOT_AVAILABLE
  );
}
