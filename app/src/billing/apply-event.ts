// SPDX-License-Identifier: Apache-2.0

// The generic layer that applies a normalized billing event to the journal (ADR 0006, 2.12 and 2.13; #497). An adapter
// reads a provider and never touches the journal; this function is the only place where an event becomes money, the same
// for every provider.
//
// One database transaction per event, so a failure leaves nothing half applied and a redelivery applies it. In order:
//
//   1. claim      the event id of this provider. A repeat is `duplicate_ignored` (the first idempotency layer; two
//                 deliveries at the same moment cannot both pass: the claim is a primary key).
//   2. resolve    the workspace comes from THE TOP-UP INTENT THE APP WROTE, found by the payment or checkout id recorded
//                 on it or by our own intent id, and cross-checked: an event that names another intent than the one the
//                 payment belongs to, or another payment than the one recorded, resolves to nothing. Nothing a buyer or
//                 a provider field says maps a payment to a workspace. The intent row is locked, so every event about
//                 one payment (its credit, its refunds, its disputes) is applied one after the other.
//   3. order      a state of a refund or dispute that is older than the last one applied is `stale_ignored`.
//   4. bound      a credit is at most the amount WE asked for (and at least the minimum top-up); a refund or dispute is
//                 at most what the intent credited. Provider amounts are data: they never exceed our own record.
//   5. write      a `top_up` keyed by the payment (D14: two events for one payment credit once); a `refund` or
//                 `chargeback` keyed by the refund or dispute, even beyond the unspent balance (it goes negative and
//                 blocks the workspace); a `correction` that reverses a debit once.
//
// The outcome (a code, no payload) is recorded with the event id in the same transaction.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentDirectory } from "../db/repositories/billing-topup-intent-directory-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import {
  BillingAdapterError,
  TOP_UP_MIN_MICRO_USD,
  isAdapterId,
  validateBillingEvent,
  type BillingEvent,
  type BillingEventOutcome,
} from "./adapter.ts";
import { BillingJournalError } from "./journal.ts";
import type { TopUpIntent } from "./topup-intent.ts";

export type ApplyResult = {
  outcome: BillingEventOutcome;
  /** The workspace the event was applied to or resolved to; null when it resolved to none or was a repeat. */
  workspaceId: string | null;
};

type Handled = { outcome: BillingEventOutcome; workspaceId: string | null };

type Context = {
  trx: Kysely<Database>;
  provider: string;
  now: () => Date;
};

function inTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

/** What orders the states of one refund or dispute; null for the events that are not about those. */
function orderOf(event: BillingEvent): {
  subject: string | null;
  occurredAt: string | null;
} {
  if (event.type === "refund.updated")
    return { subject: `refund:${event.refund}`, occurredAt: event.occurredAt };
  if (event.type === "dispute.updated")
    return {
      subject: `dispute:${event.dispute}`,
      occurredAt: event.occurredAt,
    };
  return { subject: null, occurredAt: null };
}

type Reference = {
  payment: string | null;
  checkout: string | null;
  intentId: string | null;
};

/**
 * The intent an event belongs to, locked, or undefined. The lookup order is the payment recorded on an intent, the
 * checkout recorded on it, then our own intent id; whichever finds an intent, the others must not contradict it.
 */
async function resolveIntent(
  { trx, provider }: Context,
  reference: Reference,
): Promise<TopUpIntent | undefined> {
  const directory = createBillingTopUpIntentDirectory(trx);
  const candidate =
    (reference.payment === null
      ? undefined
      : await directory.findByPayment(provider, reference.payment)) ??
    (reference.checkout === null
      ? undefined
      : await directory.findByCheckout(provider, reference.checkout)) ??
    (reference.intentId === null
      ? undefined
      : await directory.findById(provider, reference.intentId));
  if (candidate === undefined) return undefined;

  const intent = await directory.lockById(candidate.id);
  if (intent === undefined || intent.adapter !== provider) return undefined;
  if (reference.intentId !== null && reference.intentId !== intent.id)
    return undefined;
  if (
    intent.paymentRef !== null &&
    reference.payment !== null &&
    intent.paymentRef !== reference.payment
  )
    return undefined;
  if (
    intent.checkoutRef !== null &&
    reference.checkout !== null &&
    intent.checkoutRef !== reference.checkout
  )
    return undefined;
  return intent;
}

const unresolved: Handled = { outcome: "intent_unresolved", workspaceId: null };

async function paymentSucceeded(
  context: Context,
  event: Extract<BillingEvent, { type: "payment.succeeded" }>,
): Promise<Handled> {
  const intent = await resolveIntent(context, event);
  if (intent === undefined) return unresolved;
  const workspaceId = intent.workspaceId;

  // The provider's amount is data. The credit is at most what we asked for and at least the smallest top-up.
  if (
    event.creditable < TOP_UP_MIN_MICRO_USD ||
    event.creditable > intent.amountMicroUsd
  )
    return { outcome: "amount_rejected", workspaceId };

  const journal = createBillingJournalRepository(
    context.trx,
    workspaceId,
    context.now,
  );
  let created: boolean;
  try {
    created = (
      await journal.append({
        type: "top_up",
        amountMicroUsd: event.creditable,
        refKey: event.payment,
        provider: context.provider,
        providerRef: event.payment,
      })
    ).created;
  } catch (error) {
    if (
      error instanceof BillingJournalError &&
      error.code === "idempotency_conflict"
    )
      return { outcome: "amount_conflict", workspaceId };
    throw error;
  }
  await createBillingTopUpIntentsRepository(
    context.trx,
    workspaceId,
    context.now,
  ).markPaid(intent.id, {
    paymentRef: event.payment,
    ...(event.checkout === null ? {} : { checkoutRef: event.checkout }),
  });
  return { outcome: created ? "applied" : "duplicate_ignored", workspaceId };
}

async function paymentFailed(
  context: Context,
  event: Extract<BillingEvent, { type: "payment.failed" }>,
): Promise<Handled> {
  const intent = await resolveIntent(context, event);
  if (intent === undefined) return unresolved;
  const change = await createBillingTopUpIntentsRepository(
    context.trx,
    intent.workspaceId,
    context.now,
  ).markFailed(intent.id);
  return {
    outcome: change?.changed === true ? "applied" : "duplicate_ignored",
    workspaceId: intent.workspaceId,
  };
}

/** A debit (`refund`, `chargeback`) or the reversal of one, for a payment the app credited. */
async function paymentReversal(
  context: Context,
  event: Extract<BillingEvent, { type: "refund.updated" | "dispute.updated" }>,
): Promise<Handled> {
  const intent = await resolveIntent(context, {
    payment: event.payment,
    checkout: null,
    intentId: null,
  });
  // Nothing was credited for this payment (yet): a redelivery after the credit applies it.
  if (intent === undefined || intent.state !== "paid") return unresolved;
  const workspaceId = intent.workspaceId;

  const { subject, occurredAt } = orderOf(event);
  if (
    subject !== null &&
    occurredAt !== null &&
    (await createBillingWebhookEventsRepository(context.trx).hasNewerState(
      context.provider,
      subject,
      occurredAt,
    ))
  )
    return { outcome: "stale_ignored", workspaceId };

  const isRefund = event.type === "refund.updated";
  const type = isRefund ? "refund" : "chargeback";
  const ref = isRefund ? event.refund : event.dispute;
  const takesMoney = isRefund
    ? event.status === "pending" || event.status === "approved"
    : event.status === "opened" || event.status === "lost";
  const journal = createBillingJournalRepository(
    context.trx,
    workspaceId,
    context.now,
  );

  if (takesMoney) {
    // Never more than the payment credited, whatever the provider says.
    if (event.amount > intent.amountMicroUsd)
      return { outcome: "amount_rejected", workspaceId };
    try {
      const { created } = await journal.append({
        type,
        amountMicroUsd: -event.amount,
        refKey: ref,
        provider: context.provider,
        providerRef: ref,
        note: isRefund
          ? `initiated by ${event.initiatedBy}`
          : `dispute ${event.status}`,
      });
      return {
        outcome: created ? "applied" : "duplicate_ignored",
        workspaceId,
      };
    } catch (error) {
      if (
        error instanceof BillingJournalError &&
        error.code === "idempotency_conflict"
      )
        return { outcome: "amount_conflict", workspaceId };
      throw error;
    }
  }

  const original = await journal.findByKey(type, ref);
  if (original === undefined)
    return { outcome: "nothing_to_reverse", workspaceId };
  try {
    const { created } = await journal.append({
      type: "correction",
      amountMicroUsd: -original.amountMicroUsd,
      refKey: `reversal:${type}:${ref}`,
      reversesEntryId: original.id,
      provider: context.provider,
      providerRef: ref,
      note: `reversal: ${event.status}`,
    });
    return { outcome: created ? "applied" : "duplicate_ignored", workspaceId };
  } catch (error) {
    if (
      error instanceof BillingJournalError &&
      error.code === "already_reversed"
    )
      return { outcome: "duplicate_ignored", workspaceId };
    throw error;
  }
}

function handle(context: Context, event: BillingEvent): Promise<Handled> {
  switch (event.type) {
    case "ignored":
      return Promise.resolve({ outcome: "ignored_type", workspaceId: null });
    case "payment.succeeded":
      return paymentSucceeded(context, event);
    case "payment.failed":
      return paymentFailed(context, event);
    case "refund.updated":
    case "dispute.updated":
      return paymentReversal(context, event);
  }
}

/**
 * Applies one normalized event in one transaction (or in the caller's, when it hands in a transaction). Throws
 * `event_invalid` for something that is not a normalized event (nothing is recorded); any other error rolls the
 * transaction back, so the event can be delivered again.
 */
export async function applyBillingEvent(
  db: Kysely<Database>,
  input: { provider: string; event: BillingEvent; now?: () => Date },
): Promise<ApplyResult> {
  const { provider, event } = input;
  if (!isAdapterId(provider))
    throw new BillingAdapterError(
      "adapter_id_invalid",
      "an event comes from an adapter with a valid id",
    );
  validateBillingEvent(event);
  const now = input.now ?? (() => new Date());

  return inTransaction(db, async (trx) => {
    const events = createBillingWebhookEventsRepository(trx);
    const claim = await events.claim(
      provider,
      event.eventId,
      formatTimestamp(now()),
    );
    if (!claim.claimed)
      return { outcome: "duplicate_ignored", workspaceId: null };

    const handled = await handle({ trx, provider, now }, event);
    await events.finish(
      provider,
      event.eventId,
      handled.outcome,
      orderOf(event),
    );
    return handled;
  });
}
