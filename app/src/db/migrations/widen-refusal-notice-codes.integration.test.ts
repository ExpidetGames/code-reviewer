// SPDX-License-Identifier: Apache-2.0

// #498: a refusal for the balance gets a notice too, so the check on `refusal_notices.code` takes two more codes
// (`insufficient_balance`, `balance_negative`). The rows of an existing database survive the change, with their dedupe and
// the index of the sweep, and a code that is no notice code is still refused. SQLite rebuilds the table (a check cannot be
// changed in place); Postgres replaces the constraint.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const SPLIT = "20261021090000_widen_refusal_notice_codes";
const T = "2026-10-12T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

type Db = ReturnType<typeof openDatabase>;

async function seedNotice(db: Db, code: string, period = "2026-10-01") {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', null, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', '1', '{}', 'active', ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', '1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into refusal_notices (id, workspace_id, repository_id, pr_number, period_start, code, state, attempts, next_attempt_at, created_at, updated_at)
    values (${`n-${code}-${period}`}, 'w-1', 'r-1', 7, ${period}, ${code}, 'pending', 0, ${T}, ${T}, ${T})`.execute(
    db,
  );
}

describe("the refusal notice codes migration", () => {
  // #498-T03
  it("keeps the notices of an existing SQLite database and accepts the codes of the balance", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    await migrateToLatest(db, beforeThisMigration);
    await seedNotice(db, "quota_exhausted");

    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{ id: string; code: string }>`select id, code from refusal_notices`.execute(
      db,
    );
    expect(rows).toEqual([{ id: "n-quota_exhausted-2026-10-01", code: "quota_exhausted" }]);
    await seedNotice(db, "insufficient_balance", "head:abc1234");
    await seedNotice(db, "balance_negative", "head:def5678");
    await expect(seedNotice(db, "not_a_notice", "head:0000000")).rejects.toThrow();
    // The dedupe survives: the same pull request and period cannot hold two notices.
    await expect(seedNotice(db, "workspace_suspended", "head:abc1234")).rejects.toThrow();
    const indexes = await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = 'refusal_notices'`.execute(
      db,
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "refusal_notices_pull_request_period",
        "refusal_notices_due",
      ]),
    );
    await db.destroy();
  });

  // #498-T03
  it.skipIf(!hasPostgres())(
    "accepts the codes of the balance on Postgres and still refuses any other",
    async () => {
      const { db } = await createPostgresTestDatabase();

      await seedNotice(db as unknown as Db, "insufficient_balance", "head:abc1234");
      await seedNotice(db as unknown as Db, "balance_negative", "head:def5678");
      await expect(
        seedNotice(db as unknown as Db, "not_a_notice", "head:0000000"),
      ).rejects.toThrow();
    },
  );
});
