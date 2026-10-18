// SPDX-License-Identifier: Apache-2.0

// #440: when the app last started creating the price of a `billing_plan_prices` row at Paddle (docs/decisions/0005, 2.11;
// src/billing/README.md, "Creating prices"). A price the app creates has an intent row first; a row that is `pending` and
// whose attempt is older than the time a request can take is an attempt that died (a restart, a function that timed out),
// and the next request takes it over after it has looked at Paddle. Without the time a pending row would block its slot
// for ever, or two admins would create the same price.
//
// Forward only for an app of the previous release: one nullable column without a default, so no row is touched and the
// previous release, which names its columns, never sees it. No trigger changes: the guards name the identity columns only.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("billing_plan_prices")
      .addColumn("attempted_at", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("billing_plan_prices")
      .dropColumn("attempted_at")
      .execute();
  },
};
