// `rate_limits`: shared counters with a window, for the endpoints that must be rate limited the same
// way whichever app instance a request reaches (sign in, verification, password reset, invitations;
// docs/decisions/0001-editions-setup-and-accounts.md, section 2.10). One row per counter `key`
// (chosen by the caller, for example `sign-in:email:<hash>`); the counter starts again when its
// window is over. The setup code has its own counters in memory, by design (it is per process).
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("rate_limits")
      .addColumn("key", "text", (column) => column.primaryKey())
      .addColumn("window_started_at", "text", (column) => column.notNull())
      .addColumn("count", "integer", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("rate_limits").execute();
  },
};
