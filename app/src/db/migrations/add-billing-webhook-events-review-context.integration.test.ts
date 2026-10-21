// SPDX-License-Identifier: Apache-2.0

// #502: whose payment a reviewed webhook event is. The row of an event that an operator has to look at carried only the
// provider's reference; it now carries the workspace id and the intent id when the application could attribute the event.
// Two nullable columns, no row touched: an event recorded before them reads as "not attributed", and the version that is
// still running keeps working on the same database. On SQLite and, when TEST_DATABASE_URL is set, Postgres.
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

const THIS = "20261021190100_add_billing_webhook_events_review_context";
const T = "2026-10-21T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = ReturnType<typeof openDatabase>;

async function seedReview(db: Db) {
  await sql`insert into billing_webhook_events (provider, event_id, outcome, subject, received_at, review_state) values ('stripe', 'evt_1', 'amount_rejected', 'payment:pi_1', ${T}, 'open')`.execute(
    db,
  );
}

async function contextOf(db: Db): Promise<unknown> {
  const { rows } = await sql<{
    outcome: string;
    workspace_id: string | null;
    intent_id: string | null;
  }>`select outcome, workspace_id, intent_id from billing_webhook_events where event_id = 'evt_1'`.execute(
    db,
  );
  return rows;
}

describe("the review context of a webhook event", () => {
  // #502-T19
  it("is added on SQLite, leaves an existing event unattributed and stores an attribution", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    try {
      await migrateToLatest(db, beforeThisMigration);
      await seedReview(db);

      await migrateToLatest(db);

      expect(await contextOf(db)).toEqual([
        { outcome: "amount_rejected", workspace_id: null, intent_id: null },
      ]);
      await sql`update billing_webhook_events set workspace_id = 'w-1', intent_id = 'i-1' where event_id = 'evt_1'`.execute(
        db,
      );
      expect(await contextOf(db)).toEqual([
        { outcome: "amount_rejected", workspace_id: "w-1", intent_id: "i-1" },
      ]);
    } finally {
      await db.destroy();
    }
  });

  // #502-T19
  const onPostgres = hasPostgres() ? it : it.skip;
  onPostgres(
    "is added on Postgres, leaves an existing event unattributed and stores an attribution",
    async () => {
      const { db } = await createPostgresTestDatabase({ migrate: false });
      await migrateToLatest(db, beforeThisMigration);
      await seedReview(db);

      await migrateToLatest(db);

      expect(await contextOf(db)).toEqual([
        { outcome: "amount_rejected", workspace_id: null, intent_id: null },
      ]);
      await sql`update billing_webhook_events set workspace_id = 'w-1', intent_id = 'i-1' where event_id = 'evt_1'`.execute(
        db,
      );
      expect(await contextOf(db)).toEqual([
        { outcome: "amount_rejected", workspace_id: "w-1", intent_id: "i-1" },
      ]);
    },
  );
});
