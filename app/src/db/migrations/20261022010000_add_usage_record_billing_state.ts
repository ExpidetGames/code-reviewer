// SPDX-License-Identifier: LicenseRef-Proprietary

// #605: whether the money of a run is still to be settled. No amount is held at the claim any more, so the journal no
// longer says which jobs were claimed with billing on; this column does. `open` is written by a claim that passed the
// balance check with billing on, `settled` by the one settlement of the job (a charge, or none when the run is free). A
// job claimed with billing off keeps null and is never charged, whatever the switch is when it ends.
//
// Forward-only and safe next to a previous release: the column is nullable, an older instance writes records without it and
// never reads it. No row changes: a job that holds an old reservation is settled through that reservation, whatever its
// state here. The check restates BILLING_STATES in src/usage/usage-records.ts, on its own column, which both SQLite and
// Postgres accept on `add column`.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("usage_records")
      .addColumn("billing_state", "text", (column) =>
        column.check(
          sql`billing_state is null or billing_state in ('open', 'settled')`,
        ),
      )
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("usage_records")
      .dropColumn("billing_state")
      .execute();
  },
};
