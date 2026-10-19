// SPDX-License-Identifier: Apache-2.0

// The top-up intents and the record of provider events for prepaid billing (ADR 0006, 2.13 and 2.12; #497). Both tables
// are new and empty and no existing row is touched, so an app of the previous release keeps working on the same database.
//
// `billing_topup_intents` is the row the application writes BEFORE any checkout exists. It is the only way a payment
// reaches a workspace: the workspace comes from this row, never from a field the provider (or a buyer) supplies. The
// provider's ids of the checkout and the payment are recorded on it once known and are unique per adapter. The amount
// is what WE asked for, in micro-USD (`bigint` on Postgres, like the journal), and bounds the credit.
//
// `billing_webhook_events` deduplicates deliveries of an adapter by event id (the first idempotency layer; the journal
// key is the second). It stores an id, an outcome and the order of a refund or dispute state, and no payload, no
// address, no name and no amount, so nothing in it is customer data and the table is instance level.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

export const migration: Migration = {
  async up(db) {
    const money = databaseDriver(db) === "postgres" ? "bigint" : "integer";
    await db.schema
      .createTable("billing_topup_intents")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // The id of the adapter that creates the checkout ('stripe', 'manual', ...).
      .addColumn("adapter", "text", (column) => column.notNull())
      .addColumn("amount_micro_usd", money, (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      // The provider's opaque ids, null until known.
      .addColumn("provider_checkout_ref", "text")
      .addColumn("provider_payment_ref", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_topup_intents_state_check",
        sql`state in ('pending', 'paid', 'failed', 'expired')`,
      )
      .addCheckConstraint(
        "billing_topup_intents_amount_check",
        sql`amount_micro_usd > 0`,
      )
      .execute();

    // One payment and one checkout session belong to one intent of an adapter. NULLs do not collide on either engine.
    await db.schema
      .createIndex("billing_topup_intents_payment")
      .on("billing_topup_intents")
      .columns(["adapter", "provider_payment_ref"])
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_topup_intents_checkout")
      .on("billing_topup_intents")
      .columns(["adapter", "provider_checkout_ref"])
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_topup_intents_workspace")
      .on("billing_topup_intents")
      .columns(["workspace_id", "created_at"])
      .execute();

    await db.schema
      .createTable("billing_webhook_events")
      .addColumn("provider", "text", (column) => column.notNull())
      .addColumn("event_id", "text", (column) => column.notNull())
      // A BillingEventOutcome (src/billing/adapter.ts), or 'processing' inside the transaction that handles the event.
      .addColumn("outcome", "text", (column) => column.notNull())
      // The refund or dispute the event is about ('refund:<id>', 'dispute:<id>'), with the time it happened at the
      // provider: the order of the states of one object. Null for the other events.
      .addColumn("subject", "text")
      .addColumn("occurred_at", "text")
      .addColumn("received_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("billing_webhook_events_pk", [
        "provider",
        "event_id",
      ])
      .execute();
    await db.schema
      .createIndex("billing_webhook_events_subject")
      .on("billing_webhook_events")
      .columns(["provider", "subject", "occurred_at"])
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_webhook_events").execute();
    await db.schema.dropTable("billing_topup_intents").execute();
  },
};
