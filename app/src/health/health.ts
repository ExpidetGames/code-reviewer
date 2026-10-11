// SPDX-License-Identifier: Apache-2.0

// The answer of GET /api/health: the app is up and can read its database. Kept minimal on purpose;
// the deployment ticket extends it.
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

export type HealthReport = { status: "ok" } | { status: "error" };

/** `getDb` is called inside the check: an app that never opened its database reports an error too. */
export async function checkHealth(
  getDb: () => Kysely<Database>,
): Promise<HealthReport> {
  try {
    // Reads a table, not just `select 1`: a file without the schema is not a healthy database.
    await sql`select 1 from app_meta limit 1`.execute(getDb());
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
