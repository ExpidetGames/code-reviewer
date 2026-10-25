// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: whose payment a reviewed webhook event is. The row of an event that an operator has to look at carried only the
// provider's reference; it now carries the workspace id and the intent id when the application could attribute the event.
// Two nullable columns, no row touched: an event recorded before them reads as "not attributed", and the version that is
// still running keeps working on the same database.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

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

type Db = Kysely<Database>;

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
  it("is added on Postgres, leaves an existing event unattributed and stores an attribution", async () => {
    const { db } = await createEmptyTestDatabase();
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
  });
});
