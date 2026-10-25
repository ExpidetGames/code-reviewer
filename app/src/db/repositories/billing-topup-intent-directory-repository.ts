// SPDX-License-Identifier: LicenseRef-Proprietary

// Finds a top-up intent from what a provider event names, before the workspace is known (the webhook route and the
// application of an event have only the event). Instance level on purpose: it only reads, every answer names its
// workspace, and whatever is done next goes through the intents repository and the journal of THAT workspace
// (src/db/repositories/scoping.test.ts lists the reason). An intent is found only for the adapter that created it, so a
// payment reference of one provider never matches an intent of another.
import "server-only";
import type { Kysely } from "kysely";
import type { TopUpIntent } from "../../billing/topup-intent.ts";
import { databaseDriver } from "../driver.ts";
import type { Database } from "../schema.ts";
import { toTopUpIntent } from "./billing-topup-intents-repository.ts";

export type BillingTopUpIntentDirectory = {
  findById(adapter: string, id: string): Promise<TopUpIntent | undefined>;
  findByPayment(adapter: string, ref: string): Promise<TopUpIntent | undefined>;
  findByCheckout(
    adapter: string,
    ref: string,
  ): Promise<TopUpIntent | undefined>;
  /**
   * Reads the intent and holds its row until the transaction ends: every event about one payment (its
   * credit, its refunds, its disputes) is applied one after the other. Call it inside the transaction that applies the event.
   */
  lockById(id: string): Promise<TopUpIntent | undefined>;
  /**
   * True when an intent of the adapter is still `pending` with no payment recorded and was written at or after `since`: a
   * payment nobody has told us of yet could be its payment. What a refund or dispute of a payment we cannot place is
   * judged by: it may be the one of that top-up, whose credit is still on its way (#502). One indexed read, no lock.
   */
  hasPendingWithoutPayment(adapter: string, since: string): Promise<boolean>;
};

export function createBillingTopUpIntentDirectory(
  db: Kysely<Database>,
): BillingTopUpIntentDirectory {
  async function one(
    column: "id" | "provider_payment_ref" | "provider_checkout_ref",
    adapter: string,
    value: string,
  ) {
    const row = await db
      .selectFrom("billing_topup_intents")
      .selectAll()
      .where("adapter", "=", adapter)
      .where(column, "=", value)
      .executeTakeFirst();
    return row === undefined ? undefined : toTopUpIntent(row);
  }

  return {
    findById: (adapter, id) => one("id", adapter, id),
    findByPayment: (adapter, ref) => one("provider_payment_ref", adapter, ref),
    findByCheckout: (adapter, ref) =>
      one("provider_checkout_ref", adapter, ref),

    async hasPendingWithoutPayment(adapter, since) {
      const row = await db
        .selectFrom("billing_topup_intents")
        .select("id")
        .where("adapter", "=", adapter)
        .where("state", "=", "pending")
        .where("provider_payment_ref", "is", null)
        .where("created_at", ">=", since)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async lockById(id) {
      let query = db
        .selectFrom("billing_topup_intents")
        .selectAll()
        .where("id", "=", id);
      if (databaseDriver(db) === "postgres") query = query.forUpdate();
      const row = await query.executeTakeFirst();
      return row === undefined ? undefined : toTopUpIntent(row);
    },
  };
}
