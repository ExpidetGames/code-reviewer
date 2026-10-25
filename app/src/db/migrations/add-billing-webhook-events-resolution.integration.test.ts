// SPDX-License-Identifier: LicenseRef-Proprietary

// #603: who closed a billing review, when, why and with which journal entry. The row of an event under review gains four
// nullable columns for the resolution and an index for the list of reviews; no row is touched, so a review resolved before
// them reads as "closed, no details" and the version that is still running keeps working on the same database.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261022020000_add_billing_webhook_events_resolution";
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

async function seedResolved(db: Db) {
  await sql`insert into billing_webhook_events (provider, event_id, outcome, subject, received_at, review_state) values ('stripe', 'evt_1', 'amount_rejected', 'payment:pi_1', ${T}, 'resolved')`.execute(
    db,
  );
}

async function resolutionOf(db: Db): Promise<unknown> {
  const { rows } = await sql<{
    review_state: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution_note: string | null;
    resolution_entry_id: string | null;
  }>`select review_state, resolved_at, resolved_by, resolution_note, resolution_entry_id from billing_webhook_events where event_id = 'evt_1'`.execute(
    db,
  );
  return rows;
}

const BEFORE = [
  {
    review_state: "resolved",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    resolution_entry_id: null,
  },
];
const AFTER = [
  {
    review_state: "resolved",
    resolved_at: T,
    resolved_by: "user-1",
    resolution_note: "credited by hand",
    resolution_entry_id: "entry-1",
  },
];

describe("the resolution of a billing review", () => {
  // #603-T06
  it("is added on Postgres, leaves an existing review closed without details and stores a resolution", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedResolved(db);

    await migrateToLatest(db);

    expect(await resolutionOf(db)).toEqual(BEFORE);
    await sql`update billing_webhook_events set resolved_at = ${T}, resolved_by = 'user-1', resolution_note = 'credited by hand', resolution_entry_id = 'entry-1' where event_id = 'evt_1'`.execute(
      db,
    );
    expect(await resolutionOf(db)).toEqual(AFTER);
  });
});
