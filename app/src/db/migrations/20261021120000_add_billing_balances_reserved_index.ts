// SPDX-License-Identifier: Apache-2.0

// #591: the sweep of stranded holds (src/db/repositories/billing-holds-sweep.ts) asks which workspaces have money reserved,
// every minute of a hosted deployment. A partial index of the balance rows with `reserved_micro_usd > 0` answers that from the
// workspaces that have a hold open, not from one row per workspace. Forward only and additive: an index, no column and no row,
// so the version that is still running is not affected while the migration runs. The same on both engines.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("billing_balances_reserved")
      .on("billing_balances")
      .column("workspace_id")
      .where(sql.ref("reserved_micro_usd"), ">", 0)
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("billing_balances_reserved").execute();
  },
};
