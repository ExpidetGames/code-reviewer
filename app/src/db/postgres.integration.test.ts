// SPDX-License-Identifier: LicenseRef-Proprietary

// The database layer against a real Postgres server: the migrations are recorded once, concurrent starts migrate
// exactly once behind the advisory lock, and a failing migration leaves the database unchanged.
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { checkHealth } from "../health/health.ts";
import { DatabaseError } from "./errors.ts";
import { openPostgresDatabase } from "./postgres.ts";
import { startDatabase } from "../test-support/start-database.ts";
import type { Database } from "./schema.ts";
import {
  createEmptyTestDatabase,
  createTestDatabase,
  track,
} from "../test-support/test-database.ts";

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

describe("the migrations on Postgres", () => {
  // #105-PG-03
  it("record every migration exactly once", async () => {
    const postgres = await createTestDatabase();
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
    const empty = await createEmptyTestDatabase();
    const config = {
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
    const empty = await createEmptyTestDatabase();
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
      startDatabase({ url: empty.url, poolMax: 4 }, provider),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect(await migrationNames(empty.db)).toEqual(before);
    expect(await tableExists(empty.db, "broken")).toBe(false);
  });
});

// No server needed: this proves what a start and the health check do when Postgres cannot be reached.
describe("an unreachable Postgres", () => {
  const url = "postgres://user:secret@127.0.0.1:1/app";

  // #105-PG-14
  it("fails the start with a readable code and never repeats the password", async () => {
    let error: unknown;
    try {
      await startDatabase({ url, poolMax: 1 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "DATABASE_OPEN_FAILED" });
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("127.0.0.1");
    expect(message).not.toContain("secret");
  });

  // #105-PG-14
  it("reports the health check as an error, so /api/health answers 503", async () => {
    const db = track(openPostgresDatabase({ url, poolMax: 1 }));

    expect(await checkHealth(() => db)).toEqual({ status: "error" });
  });
});
