// SPDX-License-Identifier: Apache-2.0

// The top-up intents of ONE workspace (table `billing_topup_intents`; the factory takes the workspace id, see
// ../workspace-scope.ts; ADR 0006, 2.13; src/billing/README.md). An intent is written before any checkout exists; it is
// the only thing that maps a payment to a workspace. The provider's ids are recorded on it once known and, once set, never
// change. An intent moves `pending` to `paid` or `failed`; `paid` is final. A payment can pay an intent that failed
// before (an asynchronous failure followed by a success), never the other way round.
//
// Finding an intent from a provider event, before the workspace is known, is the job of the directory next to this file.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import {
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  isAdapterId,
  isProviderRef,
} from "../../billing/adapter.ts";
import {
  TopUpIntentError,
  type TopUpDebitBucket,
  type TopUpIntent,
  type TopUpIntentState,
} from "../../billing/topup-intent.ts";
import { formatTimestamp } from "../codecs.ts";
import { databaseDriver } from "../driver.ts";
import type { BillingTopupIntentsTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export function toTopUpIntent(
  row: Selectable<BillingTopupIntentsTable>,
): TopUpIntent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    adapter: row.adapter,
    amountMicroUsd: Number(row.amount_micro_usd),
    state: row.state as TopUpIntentState,
    creditedMicroUsd: Number(row.credited_micro_usd),
    refundedMicroUsd: Number(row.refunded_micro_usd),
    disputedMicroUsd: Number(row.disputed_micro_usd),
    checkoutRef: row.provider_checkout_ref,
    paymentRef: row.provider_payment_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What changed: false when the call found the intent as it asked for it. */
export type IntentChange = { intent: TopUpIntent; changed: boolean };

export type BillingTopUpIntentsRepository = {
  /** Writes a `pending` intent. The amount is a whole micro-USD amount from 10 to 500 USD. */
  create(input: {
    adapter: string;
    amountMicroUsd: number;
  }): Promise<TopUpIntent>;
  get(id: string): Promise<TopUpIntent | undefined>;
  /** Newest first. */
  list(options: { limit: number }): Promise<TopUpIntent[]>;
  /**
   * Records the provider's ids. A null id is set; the same id again changes nothing; another id throws `ref_conflict`.
   * Undefined when the workspace has no such intent.
   */
  attachRefs(
    id: string,
    refs: { checkoutRef?: string; paymentRef?: string },
  ): Promise<IntentChange | undefined>;
  /**
   * `pending`/`failed`/`expired` to `paid`, with the payment id and what the payment credited (net, positive). Repeating
   * it changes nothing, also with another amount: what a payment credited is fixed when it is paid.
   */
  markPaid(
    id: string,
    paid: {
      paymentRef: string;
      checkoutRef?: string;
      creditedMicroUsd: number;
    },
  ): Promise<IntentChange | undefined>;
  /** `pending` to `failed`. Any other state stays as it is. */
  markFailed(id: string): Promise<IntentChange | undefined>;
  /** `pending` to `expired` (the checkout ended unpaid). Any other state stays as it is; a late payment still pays it. */
  markExpired(id: string): Promise<IntentChange | undefined>;
  /**
   * Adds `deltaMicroUsd` (negative to give room back) to the running total of what refunds or disputes took back of the
   * credit. `debit_out_of_bounds` when a total would go below zero or both together above the credit. Call it under the
   * intent lock, in the transaction that writes the journal entry. Undefined when the workspace has no such intent.
   */
  addDebited(
    id: string,
    bucket: TopUpDebitBucket,
    deltaMicroUsd: number,
  ): Promise<IntentChange | undefined>;
};

function inTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

function requireRef(value: string | undefined, what: string): void {
  if (value !== undefined && !isProviderRef(value))
    throw new TopUpIntentError("ref_invalid", `${what} is not an opaque id`);
}

export function createBillingTopUpIntentsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): BillingTopUpIntentsRepository {
  async function find(
    trx: Kysely<Database>,
    id: string,
    lock = false,
  ): Promise<TopUpIntent | undefined> {
    let query = trx
      .selectFrom("billing_topup_intents")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);
    if (lock && databaseDriver(trx) === "postgres") query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : toTopUpIntent(row);
  }

  /** The refs the intent ends up with, or `ref_conflict` when one of them would change or belongs to another intent. */
  async function mergeRefs(
    trx: Kysely<Database>,
    intent: TopUpIntent,
    refs: { checkoutRef?: string | undefined; paymentRef?: string | undefined },
  ): Promise<{ checkoutRef: string | null; paymentRef: string | null }> {
    requireRef(refs.checkoutRef, "the checkout");
    requireRef(refs.paymentRef, "the payment");
    const merged = {
      checkoutRef: intent.checkoutRef ?? refs.checkoutRef ?? null,
      paymentRef: intent.paymentRef ?? refs.paymentRef ?? null,
    };
    const conflicts =
      (intent.checkoutRef !== null &&
        refs.checkoutRef !== undefined &&
        intent.checkoutRef !== refs.checkoutRef) ||
      (intent.paymentRef !== null &&
        refs.paymentRef !== undefined &&
        intent.paymentRef !== refs.paymentRef);
    if (conflicts)
      throw new TopUpIntentError(
        "ref_conflict",
        "the intent has another provider id already",
      );
    for (const [column, value] of [
      ["provider_checkout_ref", merged.checkoutRef],
      ["provider_payment_ref", merged.paymentRef],
    ] as const) {
      if (value === null) continue;
      const taken = await trx
        .selectFrom("billing_topup_intents")
        .select("id")
        .where("adapter", "=", intent.adapter)
        .where(column, "=", value)
        .where("id", "<>", intent.id)
        .executeTakeFirst();
      if (taken !== undefined)
        throw new TopUpIntentError(
          "ref_conflict",
          "another intent holds that provider id",
        );
    }
    return merged;
  }

  async function write(
    trx: Kysely<Database>,
    intent: TopUpIntent,
    patch: {
      state?: TopUpIntentState;
      checkoutRef: string | null;
      paymentRef: string | null;
      creditedMicroUsd?: number;
      refundedMicroUsd?: number;
      disputedMicroUsd?: number;
    },
  ): Promise<TopUpIntent> {
    const row = await trx
      .updateTable("billing_topup_intents")
      .set({
        state: patch.state ?? intent.state,
        credited_micro_usd: patch.creditedMicroUsd ?? intent.creditedMicroUsd,
        refunded_micro_usd: patch.refundedMicroUsd ?? intent.refundedMicroUsd,
        disputed_micro_usd: patch.disputedMicroUsd ?? intent.disputedMicroUsd,
        provider_checkout_ref: patch.checkoutRef,
        provider_payment_ref: patch.paymentRef,
        updated_at: formatTimestamp(now()),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", intent.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTopUpIntent(row);
  }

  return {
    async create({ adapter, amountMicroUsd }) {
      if (!isAdapterId(adapter))
        throw new TopUpIntentError("adapter_invalid", "not an adapter id");
      if (
        !Number.isSafeInteger(amountMicroUsd) ||
        amountMicroUsd < TOP_UP_MIN_MICRO_USD ||
        amountMicroUsd > TOP_UP_MAX_MICRO_USD
      )
        throw new TopUpIntentError(
          "amount_out_of_range",
          "a top-up is from 10 to 500 USD",
        );
      const timestamp = formatTimestamp(now());
      const row = await db
        .insertInto("billing_topup_intents")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          adapter,
          amount_micro_usd: amountMicroUsd,
          state: "pending",
          credited_micro_usd: 0,
          refunded_micro_usd: 0,
          disputed_micro_usd: 0,
          provider_checkout_ref: null,
          provider_payment_ref: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTopUpIntent(row);
    },

    get: (id) => find(db, id),

    async list({ limit }) {
      const rows = await db
        .selectFrom("billing_topup_intents")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toTopUpIntent);
    },

    attachRefs(id, refs) {
      return inTransaction(db, async (trx) => {
        const intent = await find(trx, id, true);
        if (intent === undefined) return undefined;
        const merged = await mergeRefs(trx, intent, refs);
        if (
          merged.checkoutRef === intent.checkoutRef &&
          merged.paymentRef === intent.paymentRef
        )
          return { intent, changed: false };
        return { intent: await write(trx, intent, merged), changed: true };
      });
    },

    markPaid(id, { creditedMicroUsd, ...refs }) {
      return inTransaction(db, async (trx) => {
        const intent = await find(trx, id, true);
        if (intent === undefined) return undefined;
        if (!Number.isSafeInteger(creditedMicroUsd) || creditedMicroUsd <= 0)
          throw new TopUpIntentError(
            "amount_out_of_range",
            "a payment credits a positive whole amount",
          );
        const merged = await mergeRefs(trx, intent, refs);
        if (
          intent.state === "paid" &&
          merged.checkoutRef === intent.checkoutRef &&
          merged.paymentRef === intent.paymentRef
        )
          return { intent, changed: false };
        return {
          intent: await write(trx, intent, {
            ...merged,
            state: "paid",
            // Fixed when the payment is paid; a repeat (the same payment again) keeps it.
            creditedMicroUsd:
              intent.state === "paid"
                ? intent.creditedMicroUsd
                : creditedMicroUsd,
          }),
          changed: true,
        };
      });
    },

    markExpired(id) {
      return inTransaction(db, async (trx) => {
        const intent = await find(trx, id, true);
        if (intent === undefined) return undefined;
        if (intent.state !== "pending") return { intent, changed: false };
        return {
          intent: await write(trx, intent, {
            checkoutRef: intent.checkoutRef,
            paymentRef: intent.paymentRef,
            state: "expired",
          }),
          changed: true,
        };
      });
    },

    addDebited(id, bucket, deltaMicroUsd) {
      return inTransaction(db, async (trx) => {
        const intent = await find(trx, id, true);
        if (intent === undefined) return undefined;
        const refunded =
          intent.refundedMicroUsd + (bucket === "refund" ? deltaMicroUsd : 0);
        const disputed =
          intent.disputedMicroUsd + (bucket === "dispute" ? deltaMicroUsd : 0);
        if (
          !Number.isSafeInteger(deltaMicroUsd) ||
          refunded < 0 ||
          disputed < 0 ||
          refunded + disputed > intent.creditedMicroUsd
        )
          throw new TopUpIntentError(
            "debit_out_of_bounds",
            "a total of refunds or disputes leaves the credit of the payment",
          );
        if (deltaMicroUsd === 0) return { intent, changed: false };
        return {
          intent: await write(trx, intent, {
            checkoutRef: intent.checkoutRef,
            paymentRef: intent.paymentRef,
            refundedMicroUsd: refunded,
            disputedMicroUsd: disputed,
          }),
          changed: true,
        };
      });
    },

    markFailed(id) {
      return inTransaction(db, async (trx) => {
        const intent = await find(trx, id, true);
        if (intent === undefined) return undefined;
        if (intent.state !== "pending") return { intent, changed: false };
        return {
          intent: await write(trx, intent, {
            checkoutRef: intent.checkoutRef,
            paymentRef: intent.paymentRef,
            state: "failed",
          }),
          changed: true,
        };
      });
    },
  };
}
