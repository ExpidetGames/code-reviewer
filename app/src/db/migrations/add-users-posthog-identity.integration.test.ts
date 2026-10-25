// SPDX-License-Identifier: LicenseRef-Proprietary

// #692: the three nullable columns that hold the PostHog identity of a user. No existing row changes (each stays null, so the
// version that is still running keeps working on the same database) and a value can be stored.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";

const THIS = "20261025140000_add_users_posthog_identity";
const T = "2026-10-25T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = Kysely<Database>;

async function seedUser(db: Db) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at) values ('u-1', 'Ada', 'ada@example.test', 1, ${T}, ${T})`.execute(
    db,
  );
}

async function rowsOf(db: Db): Promise<unknown> {
  const { rows } = await sql<{
    email: string;
    posthog_distinct_id: string | null;
    posthog_session_id: string | null;
    posthog_captured_at: string | null;
  }>`select email, posthog_distinct_id, posthog_session_id, posthog_captured_at from users order by id`.execute(
    db,
  );
  return rows;
}

async function checkMigration(db: Db) {
  await migrateToLatest(db, beforeThisMigration);
  await seedUser(db);

  await migrateToLatest(db);

  expect(await rowsOf(db)).toEqual([
    {
      email: "ada@example.test",
      posthog_distinct_id: null,
      posthog_session_id: null,
      posthog_captured_at: null,
    },
  ]);
  await sql`update users set posthog_distinct_id = 'did', posthog_session_id = 'sid', posthog_captured_at = ${T} where id = 'u-1'`.execute(
    db,
  );
  expect(await rowsOf(db)).toEqual([
    {
      email: "ada@example.test",
      posthog_distinct_id: "did",
      posthog_session_id: "sid",
      posthog_captured_at: T,
    },
  ]);
}

describe("the PostHog columns of a user", () => {
  // #692-T09
  it("are added, leave an existing user empty and store a value", async () => {
    const { db } = await createEmptyTestDatabase();
    await checkMigration(db);
  });
});
