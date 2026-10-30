// SPDX-License-Identifier: LicenseRef-Proprietary

// #751: the implementer migration is expand only. It adds two empty tables and one unique index to a database made by the
// previous release's migrations (the live one has jobs, the factory's has few), changes no existing row, and gives up
// loudly instead of making the queue wait when a writer holds `jobs`.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import {
  connectPostgres,
  createEmptyTestDatabase,
} from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const SPLIT = "20261030140000_create_implementer_sessions_and_turns";
const T = "2026-10-30T08:00:00.000Z";
const NEW_TABLES = ["implementer_sessions", "implementer_turns"];

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

async function rowsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (NEW_TABLES.includes(table.name)) continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

/** A workspace with an installation, a repository and a job, the way the live database has them. */
async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', null, ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/x', 'https://github.test/acme/x', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', 7, 'https://github.test/acme/x/pull/7', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
}

describe("the implementer migration", () => {
  // #751-T01
  it("adds two empty tables to an existing database with data and changes no existing row", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    const before = await rowsOfEveryOldTable(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("implementer_sessions");

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(SPLIT);
    expect(await rowsOfEveryOldTable(db)).toEqual(before);
    const { rows } = await sql<{
      sessions: number;
      turns: number;
    }>`select (select count(*) from implementer_sessions)::int as sessions,
              (select count(*) from implementer_turns)::int as turns`.execute(
      db,
    );
    expect(rows).toEqual([{ sessions: 0, turns: 0 }]);
    await db.destroy();
  });

  // #751-T01
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const again = await migrateToLatest(db, migrationProvider);

    expect(again.executed).toEqual([]);
    await db.destroy();
  });

  // #751-T01
  it("adds exactly one index to jobs and leaves the others as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    const indexesOfJobs = async () =>
      (
        await sql<{
          name: string;
        }>`select indexname as name from pg_indexes where tablename = 'jobs' order by indexname`.execute(
          db,
        )
      ).rows.map((row) => row.name);
    const before = await indexesOfJobs();

    await migrateToLatest(db, migrationProvider);

    const after = await indexesOfJobs();
    expect(after.filter((name) => !before.includes(name))).toEqual([
      "jobs_id_workspace_unique",
    ]);
    expect(before.filter((name) => !after.includes(name))).toEqual([]);
    await db.destroy();
  });

  // #751-T01
  it("keeps the lock timeout it sets to itself: a later migration of the batch and the session do not inherit it", async () => {
    const { db, config } = await createEmptyTestDatabase({ poolMax: 1 });
    expect(config.poolMax).toBe(1);

    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{
      lock_timeout: string;
    }>`show lock_timeout`.execute(db);
    expect(rows).toEqual([{ lock_timeout: "0" }]);
    await db.destroy();
  });

  // #751-T01
  it("gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps jobs locked, then succeeds once it is gone", async () => {
    const { db, url } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    const writer = connectPostgres(url, 1).db;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    // A transaction that has written a job and does not end: the index build has to wait for it.
    const writerDone = writer.transaction().execute(async (trx) => {
      await sql`update jobs set updated_at = ${T} where id = 'j-1'`.execute(
        trx,
      );
      started();
      await held;
    });
    await writing;

    const startedAt = Date.now();
    await expect(migrateToLatest(db, migrationProvider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    const waitedMs = Date.now() - startedAt;

    expect(waitedMs).toBeLessThan(20_000);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("implementer_sessions");
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([SPLIT]) },
    );
    await db.destroy();
  }, 40_000);
});
