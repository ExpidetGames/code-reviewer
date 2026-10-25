// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: whose payment a reviewed event is. A review row carried only the provider's reference (`payment:<id>`), which an
// operator cannot map to a workspace without the provider's dashboard. When the application could attribute the event to
// one of ITS top-up intents it now records the workspace id and the intent id on the row; both stay null when it could not
// (an event about a payment of ours that nobody knows, or of someone else's on a shared account). Two ids of our own, no
// payload, no amount, nothing of the customer, so the table stays instance level. Forward only and additive: two nullable
// columns, no row touched, the same on both engines.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("billing_webhook_events")
      .addColumn("workspace_id", "text")
      .execute();
    await db.schema
      .alterTable("billing_webhook_events")
      .addColumn("intent_id", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("billing_webhook_events")
      .dropColumn("intent_id")
      .execute();
    await db.schema
      .alterTable("billing_webhook_events")
      .dropColumn("workspace_id")
      .execute();
  },
};
