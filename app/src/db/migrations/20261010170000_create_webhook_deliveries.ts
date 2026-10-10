// The webhook deliveries the app has seen, one row per `X-GitHub-Delivery` id. A redelivery of the
// same id finds its row and, once the delivery succeeded, produces no second trigger. Rows are
// short-lived: the repository prunes the old ones now and then. The delivery id is the primary key, so
// two concurrent requests with the same id cannot both insert. `claim_token` says which request owns
// the claim, so a request that stalled cannot overwrite the claim of the one that took over.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("webhook_deliveries")
      .addColumn("delivery_id", "text", (column) => column.primaryKey())
      .addColumn("event", "text", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("claim_token", "text", (column) => column.notNull())
      .addColumn("received_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex("webhook_deliveries_received_at")
      .on("webhook_deliveries")
      .column("received_at")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("webhook_deliveries").execute();
  },
};
