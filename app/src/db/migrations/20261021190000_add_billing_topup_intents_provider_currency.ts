// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: the currency the buyer was charged in, pinned on the top-up intent next to `provider_amount` when the payment is
// credited. A refund or a dispute names its own amount AND currency; an amount in another currency than the charge is no
// share of it, so the application relates the two only when the currencies are the same (a mismatch is `amount_rejected`
// and a review, not a debit and not a free pass). Forward only and additive: one nullable column, no row touched; an intent
// paid before it has none and any refund or dispute of it that names a currency is flagged for review instead of guessed.
// The same on both engines.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("billing_topup_intents")
      .addColumn("provider_currency", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("billing_topup_intents")
      .dropColumn("provider_currency")
      .execute();
  },
};
