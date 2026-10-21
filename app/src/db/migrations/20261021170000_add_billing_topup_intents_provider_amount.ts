// SPDX-License-Identifier: Apache-2.0

// #502: the amount the buyer was charged, gross, in the payment provider's unit (cents of the currency the buyer paid in),
// pinned on the top-up intent when the payment is credited. A refund or a dispute names only its own amount (Stripe's events
// carry no total of the payment), so the share of the credit that it takes back is that amount over this one
// (src/billing/net-share.ts), without a call to the provider. Forward only and additive: one nullable column, no row touched;
// an intent written before it, or paid by a provider that does not say, has none and a refund of it is flagged for review
// instead of guessed. The same on both engines.
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

export const migration: Migration = {
  async up(db) {
    const money = databaseDriver(db) === "postgres" ? "bigint" : "integer";
    await db.schema
      .alterTable("billing_topup_intents")
      .addColumn("provider_amount", money)
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("billing_topup_intents")
      .dropColumn("provider_amount")
      .execute();
  },
};
