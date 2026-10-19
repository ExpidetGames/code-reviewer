// SPDX-License-Identifier: Apache-2.0

// #548: the models.dev catalog migration is expand only: it adds empty tables to a database made by the previous
// release's migrations and changes no existing row; the checks of the tables hold what the repository relies on.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { openDatabase } from "../connection.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";

const SPLIT = "20261019200000_create_models_dev_catalog";
const NEW_TABLES = [
  "models_dev_providers",
  "models_dev_models",
  "models_dev_fetch_state",
];

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

const T = "2026-10-19T08:00:00.000Z";

async function rowsOfEveryTable(
  db: ReturnType<typeof openDatabase>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (NEW_TABLES.includes(table.name)) continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = rows;
  }
  return result;
}

async function migrated() {
  const directory = await createTestDirectory();
  const db = openDatabase({
    driver: "sqlite",
    path: `${directory}/app.db`,
    busyTimeoutMs: 5000,
  });
  await migrateToLatest(db, migrationProvider);
  return db;
}

describe("the models.dev catalog migration", () => {
  // #548-T03
  it("adds empty tables to an existing database and changes no existing row", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    await migrateToLatest(db, beforeThisMigration);
    await db
      .insertInto("workspaces")
      .values({
        id: "w-1",
        name: "acme",
        slug: "acme",
        created_by: null,
        created_at: T,
      })
      .execute();
    const before = await rowsOfEveryTable(db);
    for (const name of NEW_TABLES)
      expect(
        (await db.introspection.getTables()).map((table) => table.name),
      ).not.toContain(name);

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    for (const name of NEW_TABLES) {
      const { rows } = await sql<{
        count: number;
      }>`select count(*) as count from ${sql.table(name)}`.execute(db);
      expect(rows).toEqual([{ count: 0 }]);
    }
    await db.destroy();
  });

  // #548-T08
  it("refuses a provider that is trusted without a trusted address, or in a state the code does not know", async () => {
    const db = await migrated();
    const insert = (state: string, trusted: string | null) =>
      sql`insert into models_dev_providers (provider_id, name, url_state, trusted_url, first_seen_at, updated_at)
        values (${`p-${state}-${String(trusted)}`}, 'P', ${state}, ${trusted}, ${T}, ${T})`.execute(
        db,
      );

    await expect(insert("trusted", null)).rejects.toThrow();
    await expect(insert("approved", "https://a.example/v1")).rejects.toThrow();
    await expect(
      insert("trusted", "https://a.example/v1"),
    ).resolves.toBeDefined();
    await expect(insert("rejected", null)).resolves.toBeDefined();
    await db.destroy();
  });

  // #548-T03
  it("refuses a model of a provider that is not there, and a second row for the same model", async () => {
    const db = await migrated();
    const model = (provider: string) =>
      sql`insert into models_dev_models (provider_id, model_id, name, context_limit, output_limit, reasoning, temperature, attachment, modalities, first_seen_at, updated_at)
        values (${provider}, 'm', 'M', 1000, 100, 0, 1, 0, '{}', ${T}, ${T})`.execute(
        db,
      );
    await sql`insert into models_dev_providers (provider_id, name, url_state, first_seen_at, updated_at)
      values ('p', 'P', 'rejected', ${T}, ${T})`.execute(db);

    await expect(model("nobody")).rejects.toThrow();
    await expect(model("p")).resolves.toBeDefined();
    await expect(model("p")).rejects.toThrow();
    await db.destroy();
  });

  // #548-T04
  it("keeps one row of fetch state, and refuses a status the code does not know", async () => {
    const db = await migrated();
    const insert = (id: string, status: string) =>
      sql`insert into models_dev_fetch_state (id, last_status) values (${id}, ${status})`.execute(
        db,
      );

    await expect(insert("other", "ok")).rejects.toThrow();
    await expect(insert("models.dev", "lost")).rejects.toThrow();
    await expect(insert("models.dev", "ok")).resolves.toBeDefined();
    await expect(insert("models.dev", "failed")).rejects.toThrow();
    await db.destroy();
  });
});
