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
//   4. bound      a credit is at most the amount WE asked for (and at least the minimum top-up). A refund or dispute
//                 arrives GROSS, in the provider's unit, with the amount of the whole payment (`netShareMicroUsd`:
//                 `credited x amount / paymentAmount`, rounded down): the net share is what is debited. The intent
//                 keeps two running totals, of refunds and of disputes, and together they never exceed what the
//                 payment credited (a check in the database too). Provider amounts are data: they never exceed our
//                 own record, whatever the provider repeats or accumulates.
//   5. write      a `top_up` keyed by the payment (D14: two events for one payment credit once); a `refund` or
//                 `chargeback` keyed by the refund or dispute, even beyond the unspent balance (it goes negative and
//                 blocks the workspace); a `correction` that reverses a debit once and gives its room back.
//
// The outcome (a code, no payload) is recorded with the event id in the same transaction. An event that moved money (or
// claimed to) and changed nothing (`BILLING_REVIEW_OUTCOMES`) is recorded for review; a signed event that is not a
// normalized event is recorded `event_invalid` and answered like any other, so the provider stops redelivering it.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentDirectory } from "../db/repositories/billing-topup-intent-directory-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_REVIEW_OUTCOMES,
  BillingAdapterError,
  TOP_UP_MIN_MICRO_USD,
  isAdapterId,
  isProviderRef,
  validateBillingEvent,
  type BillingEvent,
  type BillingEventOutcome,
} from "./adapter.ts";
import { BillingJournalError } from "./journal.ts";
import { netShareMicroUsd } from "./net-share.ts";
import type { TopUpIntent } from "./topup-intent.ts";

export type ApplyResult = {
  outcome: BillingEventOutcome;
  /** The workspace the event was applied to or resolved to; null when it resolved to none or was a repeat. */
  workspaceId: string | null;
  /** True when an operator has to look at the event: it moved money (or claimed to) and changed nothing. */
  needsReview: boolean;
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
  // A payment has no states to order; its reference is what a review of the event names.
  if (event.type === "payment.succeeded")
    return { subject: `payment:${event.payment}`, occurredAt: null };
  if (event.type === "payment.refused" && event.payment !== null)
    return { subject: `payment:${event.payment}`, occurredAt: null };
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
    creditedMicroUsd: event.creditable,
    ...(event.providerAmount === undefined
      ? {}
      : { providerAmount: event.providerAmount }),
    paymentRef: event.payment,
    ...(event.checkout === null ? {} : { checkoutRef: event.checkout }),
  });
  return { outcome: created ? "applied" : "duplicate_ignored", workspaceId };
}

/** The end of a payment that did not happen: `failed` (it was refused) or `expired` (nobody paid the checkout). */
async function paymentEnded(
  context: Context,
  event: Extract<BillingEvent, { type: "payment.failed" | "payment.expired" }>,
): Promise<Handled> {
  const intent = await resolveIntent(context, event);
  if (intent === undefined) return unresolved;
  const intents = createBillingTopUpIntentsRepository(
    context.trx,
    intent.workspaceId,
    context.now,
  );
  const change = await (event.type === "payment.failed"
    ? intents.markFailed(intent.id)
    : intents.markExpired(intent.id));
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
  const bucket = isRefund ? "refund" : "dispute";
  const ref = isRefund ? event.refund : event.dispute;
  const takesMoney = isRefund
    ? event.status === "pending" || event.status === "approved"
    : event.status === "opened" || event.status === "lost";
  const journal = createBillingJournalRepository(
    context.trx,
    workspaceId,
    context.now,
  );
  const intents = createBillingTopUpIntentsRepository(
    context.trx,
    workspaceId,
    context.now,
  );

  if (takesMoney) {
    // The total of the payment: the one the event carries, or else the one pinned when the payment was credited (a Stripe
    // refund names only its own amount). Both, when they differ, are a provider that contradicts itself.
    const pinned = intent.providerAmount;
    if (
      event.paymentAmount !== undefined &&
      pinned !== null &&
      event.paymentAmount !== pinned
    )
      return { outcome: "amount_conflict", workspaceId };
    const paymentAmount = event.paymentAmount ?? pinned;
    if (paymentAmount === null || paymentAmount === undefined)
      return { outcome: "amount_rejected", workspaceId };

    // The net share of what the payment credited, never more than the payment gave: the provider's amounts are gross.
    const net = netShareMicroUsd({
      credited: intent.creditedMicroUsd,
      amount: event.amount,
      paymentAmount,
    });
    if (net === undefined) return { outcome: "amount_rejected", workspaceId };

    // The debit of this refund or dispute exists already (a pending refund that is now approved, an opened dispute that
    // is now lost): it counts once.
    const existing = await journal.findByKey(type, ref);
    if (existing !== undefined)
      return {
        outcome:
          existing.amountMicroUsd === -net
            ? "duplicate_ignored"
            : "amount_conflict",
        workspaceId,
      };

    // Refunds and disputes of one payment together never debit more than it credited.
    if (
      intent.refundedMicroUsd + intent.disputedMicroUsd + net >
      intent.creditedMicroUsd
    )
      return { outcome: "amount_rejected", workspaceId };
    try {
      const { created } = await journal.append({
        type,
        amountMicroUsd: -net,
        refKey: ref,
        provider: context.provider,
        providerRef: ref,
        note: isRefund
          ? `initiated by ${event.initiatedBy}`
          : `dispute ${event.status}`,
      });
      if (created) await intents.addDebited(intent.id, bucket, net);
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
    // The room the debit took is free again.
    if (created)
      await intents.addDebited(intent.id, bucket, original.amountMicroUsd);
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
    case "payment.refused":
      // The adapter read a payment that contradicts what we asked for: nothing is credited, an operator looks.
      return Promise.resolve({ outcome: "amount_rejected", workspaceId: null });
    case "payment.succeeded":
      return paymentSucceeded(context, event);
    case "payment.failed":
    case "payment.expired":
      return paymentEnded(context, event);
    case "refund.updated":
    case "dispute.updated":
      return paymentReversal(context, event);
  }
}

/** The events that move money: what is left of one without a change in the ledger is for an operator to review. */
function movesMoney(event: BillingEvent): boolean {
  return (
    event.type === "payment.succeeded" ||
    event.type === "payment.refused" ||
    event.type === "refund.updated" ||
    event.type === "dispute.updated"
  );
}

const REVIEW_OUTCOMES: readonly BillingEventOutcome[] = BILLING_REVIEW_OUTCOMES;

/**
 * A signed event that is not a normalized event: recorded `event_invalid` under its id (when even that is an id) and
 * answered like any other event. The answer is final and the event is flagged for review: a provider that is told it
 * failed redelivers the same event for days, which never helps and can get the endpoint disabled.
 */
async function recordInvalid(
  db: Kysely<Database>,
  provider: string,
  event: unknown,
  now: () => Date,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    outcome: "event_invalid",
    workspaceId: null,
    needsReview: true,
  };
  const eventId =
    typeof event === "object" && event !== null && "eventId" in event
      ? event.eventId
      : undefined;
  if (!isProviderRef(eventId)) return result;
  return inTransaction(db, async (trx) => {
    const events = createBillingWebhookEventsRepository(trx);
    const claim = await events.claim(provider, eventId, formatTimestamp(now()));
    if (!claim.claimed)
      return {
        outcome: "duplicate_ignored",
        workspaceId: null,
        needsReview: false,
      };
    await events.finish(
      provider,
      eventId,
      "event_invalid",
      { subject: null, occurredAt: null },
      true,
    );
    return result;
  });
}

/**
 * Applies one normalized event in one transaction (or in the caller's, when it hands in a transaction). A value that is
 * not a normalized event is recorded `event_invalid` and returned, not thrown; any other error rolls the transaction
 * back, so the event can be delivered again.
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
  const now = input.now ?? (() => new Date());
  try {
    validateBillingEvent(event);
  } catch (error) {
    if (error instanceof BillingAdapterError && error.code === "event_invalid")
      return recordInvalid(db, provider, event, now);
    throw error;
  }

  return inTransaction(db, async (trx) => {
    const events = createBillingWebhookEventsRepository(trx);
    const claim = await events.claim(
      provider,
      event.eventId,
      formatTimestamp(now()),
    );
    if (!claim.claimed)
      return {
        outcome: "duplicate_ignored",
        workspaceId: null,
        needsReview: false,
      };

    const handled = await handle({ trx, provider, now }, event);
    const needsReview =
      movesMoney(event) && REVIEW_OUTCOMES.includes(handled.outcome);
    await events.finish(
      provider,
      event.eventId,
      handled.outcome,
      orderOf(event),
      needsReview,
    );
    return { ...handled, needsReview };
  });
}
