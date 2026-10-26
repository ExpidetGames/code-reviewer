// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the tables created by our migrations are the tables Better Auth expects. Better
// Auth names the tables and fields its configuration needs; after our migrations every one of them
// must exist with the data type Better Auth reads and writes, be NOT NULL where the field is
// required, and carry the unique constraints and indexes Better Auth relies on (`users.email` and
// `sessions.token` are unique: a sign-in is wrong without it). An upgrade of Better Auth, or a
// change of its configuration, that needs a new column, constraint or index fails here, and the fix
// is a new migration of ours, never a step run at start-up.
//
// Better Auth's own migration plan (`getMigrations`) is no help for this: it reports a missing
// unique index, a different type or a nullable column as a log line only, and it computes the plan
// for the dialect it is given, while the app tells Better Auth its database is `sqlite`
// (`src/auth/auth.ts`), so dates are text and booleans integers. The types below are those of that
// configuration.
import { getAuthTables } from "better-auth/db";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import { createAuthHarness } from "../test-support/auth-harness.ts";

/** The column types our migrations use for what Better Auth calls a string, number, boolean or date. */
const DATA_TYPES: Record<string, readonly string[]> = {
  string: ["text"],
  number: ["integer", "bigint"],
  boolean: ["integer"],
  date: ["text"],
};

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
};
type IndexRow = {
  table_name: string;
  is_unique: boolean;
  is_primary: boolean;
  is_partial: boolean;
  columns: string[];
};

/** What differs between the tables Better Auth needs and the database, one sentence each. */
async function driftOf(
  db: Kysely<Database>,
  options: Parameters<typeof getAuthTables>[0],
): Promise<string[]> {
  const columns = (
    await sql<ColumnRow>`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns where table_schema = 'public'`.execute(db)
  ).rows;
  const indexes = (
    await sql<IndexRow>`
      select table_class.relname as table_name,
        index_data.indisunique as is_unique,
        index_data.indisprimary as is_primary,
        index_data.indpred is not null as is_partial,
        array(
          select attribute.attname::text
          from unnest(index_data.indkey::int2[]) with ordinality as key(number, position)
          join pg_attribute attribute
            on attribute.attrelid = table_class.oid and attribute.attnum = key.number
          order by key.position
        ) as columns
      from pg_index index_data
      join pg_class table_class on table_class.oid = index_data.indrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'`.execute(db)
  ).rows;

  const drift: string[] = [];
  for (const table of Object.values(getAuthTables(options))) {
    const name = table.modelName;
    const mine = indexes.filter((index) => index.table_name === name);
    if (
      !mine.some((index) => index.is_primary && index.columns.join() === "id")
    )
      drift.push(`${name}.id is not the primary key`);

    for (const [key, field] of Object.entries(table.fields)) {
      const column = field.fieldName ?? key;
      const label = `${name}.${column}`;
      const found = columns.find(
        (row) => row.table_name === name && row.column_name === column,
      );
      if (found === undefined) {
        drift.push(`${label} is missing`);
        continue;
      }
      const accepted = DATA_TYPES[String(field.type)];
      if (accepted === undefined || !accepted.includes(found.data_type))
        drift.push(
          `${label} is ${found.data_type}, Better Auth reads a ${String(field.type)} (${(accepted ?? []).join(" or ")})`,
        );
      if (field.required !== false && found.is_nullable !== "NO")
        drift.push(`${label} may be null, the field is required`);
      if (
        field.unique === true &&
        !mine.some(
          (index) =>
            index.is_unique &&
            !index.is_partial &&
            index.columns.join() === column,
        )
      )
        drift.push(`${label} has no unique index, the field is unique`);
      if (
        field.index === true &&
        !mine.some((index) => !index.is_partial && index.columns[0] === column)
      )
        drift.push(`${label} has no index, the field is indexed`);
    }
  }
  return drift;
}

describe("the tables Better Auth needs", () => {
  it("are all created by our migrations, with nothing left for Better Auth to add", async () => {
    const harness = await createAuthHarness();

    expect(await driftOf(harness.db, harness.auth.options)).toEqual([]);
  });

  it("are checked for the unique indexes Better Auth relies on", async () => {
    const harness = await createAuthHarness();
    await sql`alter table users drop constraint users_email_key`.execute(
      harness.db,
    );
    await sql`alter table sessions drop constraint sessions_token_key`.execute(
      harness.db,
    );

    expect(await driftOf(harness.db, harness.auth.options)).toEqual([
      "users.email has no unique index, the field is unique",
      "sessions.token has no unique index, the field is unique",
    ]);
  });

  it("are checked for the indexes of the fields Better Auth looks up", async () => {
    const harness = await createAuthHarness();
    await sql`drop index sessions_user_id_index`.execute(harness.db);

    expect(await driftOf(harness.db, harness.auth.options)).toEqual([
      "sessions.user_id has no index, the field is indexed",
    ]);
  });

  it("are checked for the data type and for a column that may be null", async () => {
    const harness = await createAuthHarness();
    await sql`alter table sessions alter column ip_address type integer using 0`.execute(
      harness.db,
    );
    await sql`alter table sessions alter column expires_at drop not null`.execute(
      harness.db,
    );

    expect(await driftOf(harness.db, harness.auth.options)).toEqual([
      "sessions.expires_at may be null, the field is required",
      "sessions.ip_address is integer, Better Auth reads a string (text)",
    ]);
  });

  it("are checked for a column that is missing", async () => {
    const harness = await createAuthHarness();
    await sql`alter table accounts drop column scope`.execute(harness.db);

    expect(await driftOf(harness.db, harness.auth.options)).toEqual([
      "accounts.scope is missing",
    ]);
  });
});
