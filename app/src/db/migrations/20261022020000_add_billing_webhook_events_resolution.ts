// SPDX-License-Identifier: Apache-2.0

// #603: the resolution of a billing review. An operator closes a review row with a note, and the row keeps who did it, when,
// why and, when the repair was a manual credit or correction, the journal entry that carries it. Four nullable columns, none
// of them about the buyer (the actor is an operator, the note is the operator's own text), so the table stays instance level.
// A partial index serves the list of reviews and the count that every admin page shows, which would otherwise scan a table
// that is never pruned. Forward only and additive: no row is touched, the same on both engines.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    for (const column of [
      "resolved_at",
      "resolved_by",
      "resolution_note",
      "resolution_entry_id",
    ]) {
      await db.schema
        .alterTable("billing_webhook_events")
        .addColumn(column, "text")
        .execute();
    }
    await sql`create index billing_webhook_events_review_idx on billing_webhook_events (review_state, received_at) where review_state is not null`.execute(
      db,
    );
  },

  async down(db) {
    await sql`drop index billing_webhook_events_review_idx`.execute(db);
    for (const column of [
      "resolution_entry_id",
      "resolution_note",
      "resolved_by",
      "resolved_at",
    ]) {
      await db.schema
        .alterTable("billing_webhook_events")
        .dropColumn(column)
        .execute();
    }
  },
};
