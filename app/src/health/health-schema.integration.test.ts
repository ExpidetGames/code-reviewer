// SPDX-License-Identifier: LicenseRef-Proprietary

// The health answer in serverless mode (#319): a database that is behind this version's migrations is a
// 503 with a stable code, and nothing is migrated, created or ended on the way. In server mode the answer
// is exactly what it was.
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateToLatest } from "../db/migrate.ts";
import { closeDatabase } from "../db/startup.ts";
import type { Database } from "../db/schema.ts";
import { checkHealth } from "./health.ts";
import { healthResponse } from "./response.ts";
import {
  createEmptyTestDatabase,
  createTestDatabase,
} from "../test-support/test-database.ts";

const ahead: MigrationProvider = {
  getMigrations: async () => ({
    "0001_create_app_meta": { async up() {} },
    "99990101000000_from_the_future": { async up() {} },
  }),
};

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
});

describe("checkHealth with the schema check", () => {
  // #319-T02
  it("answers error with SCHEMA_BEHIND when the code ships a migration the database lacks, and migrates nothing", async () => {
    const { db } = await createTestDatabase();
    const exit = vi.spyOn(process, "exit");
    const log = vi.fn();

    const report = await checkHealth(() => db, {
      checkSchema: true,
      provider: ahead,
      log,
    });

    expect(report).toEqual({ status: "error", code: "SCHEMA_BEHIND" });
    const migrations = await db
      .selectFrom("kysely_migration" as never)
      .select("name" as never)
      .execute();
    expect(
      migrations.map((row) => (row as { name: string }).name),
    ).not.toContain("99990101000000_from_the_future");
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("SCHEMA_BEHIND");
    expect(String(log.mock.calls[0]?.[0])).toContain("pnpm migrate");
  });

  // #319-T02
  it("reports a database that was never migrated as behind, not as a crash", async () => {
    const { db } = await createEmptyTestDatabase();

    expect(
      await checkHealth(() => db, { checkSchema: true, log: vi.fn() }),
    ).toEqual({ status: "error", code: "SCHEMA_BEHIND" });
  });

  // #319-T02
  it("says it once per instance, not once per probe", async () => {
    const { db } = await createTestDatabase();
    const log = vi.fn();

    for (let i = 0; i < 3; i++)
      await checkHealth(() => db, { checkSchema: true, provider: ahead, log });

    expect(log).toHaveBeenCalledOnce();
  });

  // #319-T02
  it("is ok when the schema is current, and asks the migration table only until it is", async () => {
    const { db } = await createTestDatabase();
    const spy = vi.spyOn(db, "getExecutor");

    expect(await checkHealth(() => db, { checkSchema: true })).toEqual({
      status: "ok",
    });
    const afterFirst = spy.mock.calls.length;
    expect(await checkHealth(() => db, { checkSchema: true })).toEqual({
      status: "ok",
    });

    // The second probe reads app_meta only: the confirmed schema is not asked about again.
    expect(spy.mock.calls.length - afterFirst).toBeLessThan(afterFirst);
  });

  // #319-T06
  it("does not look at the schema in server mode", async () => {
    const { db } = await createTestDatabase();

    expect(await checkHealth(() => db, { provider: ahead })).toEqual({
      status: "ok",
    });
  });
});

describe("the health response of a cold serverless instance", () => {
  async function pointAt(url: string): Promise<void> {
    vi.stubEnv("DATABASE_URL", url);
    await closeDatabase();
  }

  // #319-T02
  it("is 503 with the code while the database is behind, still 503 on the next probe, and 200 once pnpm migrate ran", async () => {
    const { db, url } = await createEmptyTestDatabase();
    await pointAt(url);
    const exit = vi.spyOn(process, "exit");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const behind = await healthResponse();
    expect(behind.status).toBe(503);
    expect(await behind.json()).toEqual({
      status: "error",
      code: "SCHEMA_BEHIND",
    });
    expect((await healthResponse()).status).toBe(503);
    // The probe created no table: it is the migration command's job.
    expect(await tableNames(db)).toEqual([]);
    expect(exit).not.toHaveBeenCalled();

    await migrateToLatest(db);

    const current = await healthResponse();
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ status: "ok" });
  });

  // #319-T05
  it("opens the database on the first request of a cold instance and not before", async () => {
    const { url } = await createTestDatabase();
    await pointAt(url);
    const holder = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("code-reviewer.database");
    expect(holder[key]).toBeUndefined();

    const response = await healthResponse();

    expect(response.status).toBe(200);
    expect(holder[key]).toBeDefined();
  });
});

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const tables = await db.introspection.getTables({
    withInternalKyselyTables: true,
  });
  return tables.map((table) => table.name);
}
