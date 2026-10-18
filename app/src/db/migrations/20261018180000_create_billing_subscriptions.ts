// SPDX-License-Identifier: Apache-2.0

// The subscription state of billing (#441, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.12 and
// 2.16; src/billing/README.md, "The webhook"): four empty tables, so no existing row is touched and an app of the previous
// release, which names its columns, never sees them.
//
// - `billing_customers`: the Paddle customer a workspace pays with, adopted from `subscription.created`. Per workspace and
//   environment (one Paddle customer may serve several workspaces).
// - `billing_subscriptions`: the state of a workspace's Paddle subscription, pinned to a plan version. The partial unique
//   index lets a workspace hold one subscription that is not canceled; a second `subscription.created` is flagged, not applied.
//   `last_event_occurred_at` is the stamp the webhook orders by.
// - `billing_checkouts`: written by the server when it creates a Paddle transaction (#443), read by the webhook to find the
//   workspace and the version of a new subscription. It is the only link from a Paddle subscription to a workspace.
// - `billing_webhook_events`: instance level, the log and the dedupe of the events: one row per `event_id` (never the
//   notification id), the outcome, no payload.
//
// The workspace foreign keys are `restrict`, not `cascade`: nobody deletes a workspace today, and when somebody does, a row that
// says what a customer paid for must be dealt with on purpose, not dropped with it. Statuses, intervals and environments are
// checked in the database; the lists restate the code (`src/billing/subscription-state.ts`) and a test compares them.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("billing_customers")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("restrict"),
      )
      .addColumn("paddle_env", "text", (column) => column.notNull())
      .addColumn("paddle_customer_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("billing_customers_pkey", [
        "workspace_id",
        "paddle_env",
      ])
      .addCheckConstraint(
        "billing_customers_env_check",
        sql`paddle_env in ('sandbox', 'live')`,
      )
      .execute();

    await db.schema
      .createTable("billing_subscriptions")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("restrict"),
      )
      .addColumn("paddle_env", "text", (column) => column.notNull())
      .addColumn("paddle_subscription_id", "text", (column) => column.notNull())
      .addColumn("paddle_customer_id", "text", (column) => column.notNull())
      .addColumn("plan_version_id", "text", (column) =>
        column
          .notNull()
          .references("billing_plan_versions.id")
          .onDelete("restrict"),
      )
      .addColumn("paddle_price_id", "text", (column) => column.notNull())
      .addColumn("billing_interval", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("past_due_since", "text")
      .addColumn("started_at", "text")
      .addColumn("current_period_start", "text")
      .addColumn("current_period_end", "text")
      .addColumn("next_billed_at", "text")
      .addColumn("canceled_at", "text")
      .addColumn("scheduled_change_action", "text")
      .addColumn("scheduled_change_at", "text")
      .addColumn("last_event_occurred_at", "text", (column) => column.notNull())
      .addColumn("last_event_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_subscriptions_env_check",
        sql`paddle_env in ('sandbox', 'live')`,
      )
      .addCheckConstraint(
        "billing_subscriptions_interval_check",
        sql`billing_interval in ('month', 'year')`,
      )
      .addCheckConstraint(
        "billing_subscriptions_status_check",
        sql`status in ('active', 'trialing', 'past_due', 'paused', 'canceled')`,
      )
      .addCheckConstraint(
        "billing_subscriptions_scheduled_change_check",
        sql`scheduled_change_action is null or scheduled_change_action in ('cancel', 'pause', 'resume')`,
      )
      .execute();
    await db.schema
      .createIndex("billing_subscriptions_paddle_id")
      .on("billing_subscriptions")
      .columns(["paddle_env", "paddle_subscription_id"])
      .unique()
      .execute();
    // One subscription that is not canceled per workspace (ADR 0005, 2.12): the database refuses a second, whichever instance writes.
    await db.schema
      .createIndex("billing_subscriptions_one_live")
      .on("billing_subscriptions")
      .column("workspace_id")
      .unique()
      .where(sql<boolean>`status <> 'canceled'`)
      .execute();
    await db.schema
      .createIndex("billing_subscriptions_plan_version")
      .on("billing_subscriptions")
      .column("plan_version_id")
      .execute();

    await db.schema
      .createTable("billing_checkouts")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("restrict"),
      )
      .addColumn("paddle_env", "text", (column) => column.notNull())
      .addColumn("transaction_id", "text", (column) => column.notNull())
      .addColumn("plan_version_id", "text", (column) =>
        column
          .notNull()
          .references("billing_plan_versions.id")
          .onDelete("restrict"),
      )
      .addColumn("billing_interval", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_checkouts_env_check",
        sql`paddle_env in ('sandbox', 'live')`,
      )
      .addCheckConstraint(
        "billing_checkouts_interval_check",
        sql`billing_interval in ('month', 'year')`,
      )
      .execute();
    await db.schema
      .createIndex("billing_checkouts_transaction")
      .on("billing_checkouts")
      .columns(["paddle_env", "transaction_id"])
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_checkouts_workspace")
      .on("billing_checkouts")
      .column("workspace_id")
      .execute();

    await db.schema
      .createTable("billing_webhook_events")
      .addColumn("event_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("paddle_env", "text", (column) => column.notNull())
      .addColumn("event_type", "text", (column) => column.notNull())
      .addColumn("occurred_at", "text", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("entity_id", "text")
      .addColumn("received_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_webhook_events_env_check",
        sql`paddle_env in ('sandbox', 'live')`,
      )
      .execute();
    await db.schema
      .createIndex("billing_webhook_events_received")
      .on("billing_webhook_events")
      .column("received_at")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_webhook_events").execute();
    await db.schema.dropTable("billing_checkouts").execute();
    await db.schema.dropTable("billing_subscriptions").execute();
    await db.schema.dropTable("billing_customers").execute();
  },
};
