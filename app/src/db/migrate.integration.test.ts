// Pins down the schema bootstrap: a missing file is created and fully migrated, a second start
// changes nothing, a failing migration leaves no trace, and the migrated schema follows the
// portable column conventions.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { startDbProcess } from "../test-support/db-process.ts";
import {
  createTestDatabase,
  createTestDirectory,
  track,
} from "../test-support/test-database.ts";
import { openDatabase } from "./connection.ts";
import { DatabaseError } from "./errors.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import { createAppMetaRepository } from "./repositories/app-meta-repository.ts";
import type { Database } from "./schema.ts";
import { startDatabase } from "./startup.ts";

async function names(db: Kysely<Database>, query: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`${sql.raw(query)}`.execute(db);
  return rows.map((row) => row.name);
}

async function userTables(db: Kysely<Database>): Promise<string[]> {
  return names(
    db,
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  );
}

describe("starting the database", () => {
  // CR-15-T01
  it("creates a missing file and applies every migration in order", async () => {
    const directory = await createTestDirectory();
    const path = join(directory, "app.db");
    const expectedMigrations = Object.keys(
      await migrationProvider.getMigrations(),
    ).sort();

    const { db, migrationsApplied } = await startDatabase({
      path,
      busyTimeoutMs: 1000,
    });
    track(db);

    expect(existsSync(path)).toBe(true);
    expect(migrationsApplied).toEqual(expectedMigrations);
    expect(
      await names(db, "select name from kysely_migration order by name"),
    ).toEqual(expectedMigrations);
    expect(await userTables(db)).toEqual([
      "app_meta",
      "kysely_migration",
      "kysely_migration_lock",
    ]);
    const { rows } = await sql<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>`
      select name, type, "notnull", pk from pragma_table_info('app_meta') order by cid`.execute(
      db,
    );
    expect(rows).toEqual([
      { name: "key", type: "TEXT", notnull: 0, pk: 1 },
      { name: "value", type: "TEXT", notnull: 1, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    ]);
  });

  // CR-15-T02
  it("applies nothing and keeps the data when the file is already migrated", async () => {
    const { db: first, config } = await createTestDatabase();
    await createAppMetaRepository(first).set("greeting", "hello");
    const recorded =
      await sql`select name, timestamp from kysely_migration order by name`.execute(
        first,
      );

    const { db: second, migrationsApplied } = await startDatabase(config);
    track(second);

    expect(migrationsApplied).toEqual([]);
    expect(await createAppMetaRepository(second).get("greeting")).toBe("hello");
    expect(
      await sql`select name, timestamp from kysely_migration order by name`.execute(
        second,
      ),
    ).toEqual(recorded);
  });
});

describe("a failing migration", () => {
  const failingAfterCreatingATable: Migration = {
    async up(db) {
      await db.schema
        .createTable("half_built")
        .addColumn("id", "text", (c) => c.primaryKey())
        .execute();
      await sql`this is not valid sql`.execute(db);
    },
  };
  const provider: MigrationProvider = {
    async getMigrations() {
      return {
        ...(await migrationProvider.getMigrations()),
        "9999_broken": failingAfterCreatingATable,
      };
    },
  };

  // CR-15-T09
  it("stops with an error naming it, and rolls back the half-built table and the record", async () => {
    const directory = await createTestDirectory();
    const db = track(
      (
        await startDatabase({
          path: join(directory, "app.db"),
          busyTimeoutMs: 1000,
        })
      ).db,
    );
    const before = await userTables(db);
    const recordedBefore = await names(
      db,
      "select name from kysely_migration order by name",
    );

    const run = migrateToLatest(db, provider);

    await expect(run).rejects.toBeInstanceOf(DatabaseError);
    await expect(run).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    await expect(run).rejects.toThrow(/9999_broken/);
    expect(await userTables(db)).toEqual(before);
    expect(
      await names(db, "select name from kysely_migration order by name"),
    ).toEqual(recordedBefore);
  });

  // CR-15-T09
  it("does not keep the migrations of the same start that ran before it", async () => {
    const directory = await createTestDirectory();
    const db = track(
      openDatabase({ path: join(directory, "app.db"), busyTimeoutMs: 1000 }),
    );

    await expect(migrateToLatest(db, provider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });

    expect(await userTables(db)).not.toContain("app_meta");
    expect(await userTables(db)).not.toContain("half_built");
    expect(await names(db, "select name from kysely_migration")).toEqual([]);
  });
});

describe("migrating while another process holds the write lock", () => {
  it("reports DATABASE_LOCKED, not a broken migration, when the lock outlasts the busy timeout", async () => {
    const directory = await createTestDirectory();
    const path = join(directory, "app.db");
    const db = track(openDatabase({ path, busyTimeoutMs: 200 }));
    const holder = startDbProcess(["hold-lock", path, "0"]);
    expect(await holder.nextLine()).toBe("locked");

    const run = migrateToLatest(db);

    await expect(run).rejects.toBeInstanceOf(DatabaseError);
    await expect(run).rejects.toMatchObject({ code: "DATABASE_LOCKED" });
    await expect(run).rejects.not.toThrow(/rolled back/);
    holder.closeInput();
    expect(await holder.nextLine()).toBe("released");
  });
});

describe("the migrated schema", () => {
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  // CR-15-T06
  it("uses only text and integer columns, text ids, and text timestamps", async () => {
    const { db } = await createTestDatabase();
    // Kysely's own bookkeeping tables are not ours to shape (varchar columns).
    const tables = (await userTables(db)).filter(
      (name) => !name.startsWith("kysely_"),
    );
    expect(tables.length).toBeGreaterThan(0);

    for (const table of tables) {
      const { rows: columns } = await sql<{ name: string; type: string }>`
        select name, type from pragma_table_info(${table})`.execute(db);
      for (const column of columns) {
        expect(["TEXT", "INTEGER"], `${table}.${column.name}`).toContain(
          column.type,
        );
        if (column.name === "id" || column.name.endsWith("_id")) {
          expect(column.type, `${table}.${column.name}`).toBe("TEXT");
        }
        if (column.name.endsWith("_at")) {
          expect(column.type, `${table}.${column.name}`).toBe("TEXT");
        }
      }
      const { rows } = await sql<{
        sql: string;
      }>`select sql from sqlite_master where name = ${table}`.execute(db);
      expect(rows[0]?.sql.toLowerCase(), table).not.toContain("autoincrement");
    }
  });

  // CR-15-T06
  it("stores timestamps written by a repository as ISO 8601 text in UTC", async () => {
    const { db } = await createTestDatabase();
    await createAppMetaRepository(
      db,
      () => new Date(Date.UTC(2026, 9, 10, 12, 30, 15, 42)),
    ).set("k", "v");

    const { rows } = await sql<{ updated_at: string; type: string }>`
      select updated_at, typeof(updated_at) as type from app_meta`.execute(db);

    expect(rows[0]?.type).toBe("text");
    expect(rows[0]?.updated_at).toBe("2026-10-10T12:30:15.042Z");
    expect(rows[0]?.updated_at).toMatch(ISO_UTC);
  });
});
