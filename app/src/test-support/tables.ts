// SPDX-License-Identifier: LicenseRef-Proprietary

// The tables of a test database, for the tests that look at every one of them (what a run changed, what a refusal left
// untouched). Kysely's own bookkeeping tables are not ours and are left out.
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

export async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely\_%'
    order by table_name`.execute(db);
  return rows.map((row) => row.name);
}
