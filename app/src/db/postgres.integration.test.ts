// SPDX-License-Identifier: Apache-2.0

// The Postgres side of the database layer, against a real server: the migrations produce the same
// schema as SQLite (parity), concurrent starts migrate exactly once behind the advisory lock, and a
// failing migration leaves the database unchanged. Runs only when TEST_DATABASE_URL is set.
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import {
  hasPostgres,
  createPostgresTestDatabase,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { startDatabase } from "./startup.ts";
import type { Database } from "./schema.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

/** The database types that mean the same application value on both dialects. */
const TYPE_GROUPS: Array<[string, string[]]> = [
  ["text", ["text", "character varying", "varchar", "character", "char"]],
  ["integer", ["integer", "int", "int4", "int8", "bigint", "smallint", "int2"]],
  ["boolean", ["boolean", "bool"]],
  ["real", ["real", "double precision", "float8", "numeric", "decimal"]],
];

function canonicalType(dataType: string | undefined): string {
  const lower = (dataType ?? "").toLowerCase().trim();
  for (const [canonical, names] of TYPE_GROUPS)
    if (names.includes(lower)) return canonical;
  return lower;
}

type Shape = {
  name: string;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
};

// A primary key column is never null on either database, but SQLite reports a `text primary key`
// column as nullable (it only reports NOT NULL when the column says so). The comparison uses the
// primary keys of each dialect, so the SQLite quirk does not read as a schema difference.
async function primaryKeyColumns(
  db: Kysely<Database>,
  dialect: "sqlite" | "postgres",
): Promise<Set<string>> {
  const query =
    dialect === "sqlite"
      ? sql<{ table_name: string; column_name: string }>`
          select m.name as table_name, p.name as column_name
          from sqlite_master m join pragma_table_info(m.name) p on p.pk > 0
          where m.type = 'table' and m.name not like 'kysely_%'`
      : sql<{ table_name: string; column_name: string }>`
          select tc.table_name, kcu.column_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
           and tc.table_schema = kcu.table_schema
          where tc.constraint_type = 'PRIMARY KEY'
            and tc.table_schema = 'public'`;
  const { rows } = await query.execute(db);
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

async function schemaShape(
  db: Kysely<Database>,
  dialect: "sqlite" | "postgres",
): Promise<Shape[]> {
  const primaryKeys = await primaryKeyColumns(db, dialect);
  const tables = await db.introspection.getTables();
  return tables
    .filter((table) => !table.isView && !table.name.startsWith("kysely_"))
    .map((table) => ({
      name: table.name,
      columns: table.columns
        .map((column) => ({
          name: column.name,
          type: canonicalType(column.dataType),
          nullable:
            column.isNullable &&
            !primaryKeys.has(`${table.name}.${column.name}`),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function migrationNames(db: Kysely<Database>): Promise<string[]> {
  // A failed migration on Postgres rolls back the migration table itself, so it may not exist.
  const { rows: exists } = await sql<{ present: boolean }>`
    select to_regclass('kysely_migration') is not null as present`.execute(db);
  if (!exists[0]?.present) return [];
  const { rows } = await sql<{ name: string }>`
    select name from kysely_migration order by name`.execute(db);
  return rows.map((row) => row.name);
}

async function tableExists(
  db: Kysely<Database>,
  table: string,
): Promise<boolean> {
  const { rows } = await sql<{ present: boolean }>`
    select to_regclass(${table}) is not null as present`.execute(db);
  return rows[0]?.present ?? false;
}

describePostgres("the migrations on Postgres", () => {
  // #105-PG-03
  it("produce the same tables, columns, nullability and mapped types as SQLite", async () => {
    const postgres = await createPostgresTestDatabase();
    const sqlite = await createTestDatabase();

    expect(await schemaShape(postgres.db, "postgres")).toEqual(
      await schemaShape(sqlite.db, "sqlite"),
    );
  });

  // #105-PG-03
  it("record every migration exactly once", async () => {
    const postgres = await createPostgresTestDatabase();
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from kysely_migration`.execute(postgres.db);

    expect(rows[0]?.count).toBeGreaterThan(0);
    expect(new Set(await migrationNames(postgres.db)).size).toBe(
      rows[0]?.count,
    );
    expect(await tableExists(postgres.db, "jobs")).toBe(true);
  });

  // #105-PG-05
  it("run once when two instances start at the same time on an empty database", async () => {
    const empty = await createPostgresTestDatabase({ migrate: false });
    const config = {
      driver: "postgres" as const,
      url: empty.url,
      poolMax: 4,
    };

    const [first, second] = await Promise.all([
      startDatabase(config),
      startDatabase(config),
    ]);
    const names = await migrationNames(empty.db);
    await first.db.destroy();
    await second.db.destroy();

    // Both started and took turns: each migration was applied exactly once between them.
    expect(
      first.migrationsApplied.length + second.migrationsApplied.length,
    ).toBe(names.length);
    expect(
      new Set([...first.migrationsApplied, ...second.migrationsApplied]).size,
    ).toBe(names.length);
  });

  // #105-PG-06
  it("leave the database unchanged when a migration fails", async () => {
    const empty = await createPostgresTestDatabase({ migrate: false });
    const before = await migrationNames(empty.db);
    const failing: Migration = {
      async up(db) {
        await db.schema.createTable("broken").execute();
        throw new Error("boom");
      },
      async down(db) {
        await db.schema.dropTable("broken").execute();
      },
    };
    const provider: MigrationProvider = {
      async getMigrations() {
        return { "9999_broken": failing };
      },
    };

    await expect(
      startDatabase(
        { driver: "postgres", url: empty.url, poolMax: 4 },
        provider,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect(await migrationNames(empty.db)).toEqual(before);
    expect(await tableExists(empty.db, "broken")).toBe(false);
  });
});
