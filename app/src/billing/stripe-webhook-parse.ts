// SPDX-License-Identifier: Apache-2.0

// What a VERIFIED Stripe event becomes (ADR 0006, 2.13; #502): one normalized event of `adapter.ts`. Pure: the parsed JSON and
// the environment of the stored key come in, an event (or "not readable") comes out; nothing is asked of Stripe (the handler
// makes no outbound call), nothing is stored and nothing is logged. A body is data until its signature was verified; this runs
// after that, and still trusts nothing: every field is read through our own schemas (`stripe-schemas.ts`) and every amount is
// checked before it can become money.
//
// The mapping (the events the admin page subscribes the endpoint to, `stripe-webhook-events.ts`):
//
//   checkout.session.completed, ...async_payment_succeeded   `payment.succeeded` when the session is paid (the net amount is
//                                             `amount_total` less `amount_tax`: what the buyer paid after any discount, VAT
//                                             being on top and never credited), `ignored` while it is unpaid (a delayed
//                                             method: the success or the failure follows), and `payment.refused` when the
//                                             session contradicts what we asked for
//   checkout.session.async_payment_failed     `payment.failed`
//   checkout.session.expired                  `payment.expired`
//   refund.created / refund.updated / refund.failed   `refund.updated`, one per refund with the amount (and currency) of THAT refund
//   charge.dispute.created, ...funds_withdrawn        `dispute.updated` `opened`
//   charge.dispute.closed (won, lost, charge_refunded), ...funds_reinstated   `won` or `lost`
//   anything else                              `ignored`
//
// Not mapped on purpose: `payment_intent.succeeded` (the payment intent has no net amount, and the session event carries the
// same payment under the same journal key), `payment_intent.payment_failed` (a declined card can be retried on the same page,
// so it is not the end of the intent) and `charge.refunded` (CUMULATIVE: the refunds are told one by one). They are
// recorded `ignored_type` if Stripe sends them.
import "server-only";
import { z } from "zod";
import {
  isProviderCurrency,
  isProviderRef,
  toProviderAmount,
  toUsd,
  type BillingEvent,
  type DisputeStatus,
  type RefundInitiator,
  type RefundStatus,
} from "./adapter.ts";
import type { StripeEnvironment } from "./stripe-client.ts";
import {
  stripeCheckoutSessionSchema,
  stripeDisputeSchema,
  stripeRefundSchema,
  type StripeCheckoutSession,
} from "./stripe-schemas.ts";

export type StripeParseResult =
  { ok: true; event: BillingEvent } | { ok: false };

const MICRO_USD_PER_CENT = 10_000;
const NOT_READABLE: StripeParseResult = { ok: false };

/**
 * The metadata a refund carries when the application made it (there is no such refund in v1: the operator refunds in the
 * Stripe dashboard); `initiatedBy` is `seller` for it and only for it.
 */
export const STRIPE_REFUND_ORIGIN_METADATA = {
  source: "code-reviewer",
} as const;

const envelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

type Meta = { eventId: string; occurredAt: string };

/** What the end of a Checkout Session can be: the payment's three ends, a refused payment, or nothing for us. */
export type SessionPaymentEvent = Extract<
  BillingEvent,
  {
    type:
      | "payment.succeeded"
      | "payment.refused"
      | "payment.failed"
      | "payment.expired"
      | "ignored";
  }
>;

function isoTime(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 4e9)
    return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** The intent id we put on the session twice: the reference and the metadata. Undefined when they contradict each other. */
function intentOfSession(
  session: StripeCheckoutSession,
): string | null | undefined {
  const reference = session.client_reference_id;
  const fromMetadata = session.metadata.intent ?? null;
  if (reference !== null && fromMetadata !== null && reference !== fromMetadata)
    return undefined;
  return reference ?? fromMetadata;
}

function cents(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The end of a Checkout Session as a normalized event, from the session object alone. Shared by the webhook and by "Check
 * payment" (the same rules, whoever tells). `paid` is true for a session whose money has arrived.
 */
export function paymentEventOfSession(
  session: StripeCheckoutSession,
  meta: Meta,
  environment: StripeEnvironment,
  end: "paid" | "failed" | "expired",
): SessionPaymentEvent {
  const intentId = intentOfSession(session);
  const refused = (): SessionPaymentEvent => ({
    type: "payment.refused",
    ...meta,
    payment: session.payment_intent,
    ...(isProviderRef(intentId) ? { intentId } : {}),
  });
  if (end === "failed" || end === "expired") {
    if (intentId === undefined) return { type: "ignored", ...meta };
    return {
      type: end === "failed" ? "payment.failed" : "payment.expired",
      ...meta,
      intentId,
      payment: session.payment_intent,
      checkout: session.id,
    };
  }

  // A paid session: every value that becomes money is checked before it is trusted.
  if (session.livemode !== (environment === "live")) return refused();
  if (session.currency !== "usd") return refused();
  if (intentId === undefined || session.payment_intent === null)
    return refused();
  // What the buyer paid, net of the tax on top: the total after any discount, less the tax. The subtotal is the price BEFORE
  // a discount and would credit more than was paid. The application then requires the net to be what the intent asked for.
  const total = cents(session.amount_total);
  const tax = cents(session.total_details?.amount_tax);
  if (total === undefined || tax === undefined || tax >= total)
    return refused();
  const net = total - tax;
  // The charge is in our currency, or in the one Adaptive Pricing presented to the buyer; the refunds and disputes of the
  // payment are in that one.
  let charged = total;
  let currency = session.currency;
  if (
    session.presentment_details !== undefined &&
    session.presentment_details !== null
  ) {
    const presented = cents(session.presentment_details.presentment_amount);
    const presentedCurrency =
      session.presentment_details.presentment_currency.toLowerCase();
    if (presented === undefined || !isProviderCurrency(presentedCurrency))
      return refused();
    charged = presented;
    currency = presentedCurrency;
  }
  if (charged === 0 || !isProviderCurrency(currency)) return refused();
  return {
    type: "payment.succeeded",
    ...meta,
    intentId,
    payment: session.payment_intent,
    checkout: session.id,
    creditable: toUsd(net * MICRO_USD_PER_CENT),
    gross: toUsd(total * MICRO_USD_PER_CENT),
    tax: toUsd(tax * MICRO_USD_PER_CENT),
    providerAmount: toProviderAmount(charged),
    providerCurrency: currency,
  };
}

const REFUND_STATUS: Record<string, RefundStatus> = {
  pending: "pending",
  requires_action: "pending",
  succeeded: "approved",
  failed: "rejected",
  canceled: "rejected",
};

function refundInitiator(
  reason: string | null,
  metadata: Record<string, string>,
): RefundInitiator {
  if (metadata.source === STRIPE_REFUND_ORIGIN_METADATA.source) return "seller";
  return reason === "requested_by_customer" ? "customer" : "provider";
}

function refundEvent(object: unknown, meta: Meta): StripeParseResult {
  const refund = stripeRefundSchema.safeParse(object);
  if (!refund.success) return NOT_READABLE;
  const { payment_intent: payment, amount, status } = refund.data;
  const currency = refund.data.currency.toLowerCase();
  if (
    payment === null ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !isProviderCurrency(currency)
  )
    return NOT_READABLE;
  return {
    ok: true,
    event: {
      type: "refund.updated",
      ...meta,
      payment,
      refund: refund.data.id,
      amount: toProviderAmount(amount),
      currency,
      initiatedBy: refundInitiator(refund.data.reason, refund.data.metadata),
      // A refund with no status yet is on its way: the money is leaving, and a later failure reverses the debit.
      status:
        status === null ? "pending" : (REFUND_STATUS[status] ?? "pending"),
    },
  };
}

function disputeStatusOf(
  type: string,
  status: string,
): DisputeStatus | undefined {
  switch (type) {
    case "charge.dispute.created":
      return status.startsWith("warning_") ? undefined : "opened";
    case "charge.dispute.funds_withdrawn":
      return "opened";
    case "charge.dispute.funds_reinstated":
      return "won";
    case "charge.dispute.closed":
      if (status === "lost") return "lost";
      return status === "won" || status === "charge_refunded"
        ? "won"
        : undefined;
    default:
      return undefined;
  }
}

function disputeEvent(
  type: string,
  object: unknown,
  meta: Meta,
): StripeParseResult {
  const dispute = stripeDisputeSchema.safeParse(object);
  if (!dispute.success) return NOT_READABLE;
  const status = disputeStatusOf(type, dispute.data.status);
  // An early warning moves no money, and a dispute still under review changes nothing yet.
  if (status === undefined)
    return { ok: true, event: { type: "ignored", ...meta } };
  const payment = dispute.data.payment_intent ?? null;
  const currency = dispute.data.currency.toLowerCase();
  if (
    payment === null ||
    !Number.isSafeInteger(dispute.data.amount) ||
    dispute.data.amount <= 0 ||
    !isProviderCurrency(currency)
  )
    return NOT_READABLE;
  return {
    ok: true,
    event: {
      type: "dispute.updated",
      ...meta,
      payment,
      dispute: dispute.data.id,
      amount: toProviderAmount(dispute.data.amount),
      currency,
      status,
    },
  };
}

/**
 * Reads a verified, JSON-parsed Stripe event. `{ ok: false }` when it is not an event of a shape we can read, or belongs to
 * the other environment than the stored key's (a test event at a live instance, or the reverse): nothing of it is used.
 */
export function parseStripeWebhookEvent(
  body: unknown,
  { environment }: { environment: StripeEnvironment },
): StripeParseResult {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return NOT_READABLE;
  const { id, type, created, livemode, data } = envelope.data;
  const occurredAt = isoTime(created);
  if (occurredAt === undefined || !isProviderRef(id)) return NOT_READABLE;
  if (livemode !== (environment === "live")) return NOT_READABLE;
  const meta: Meta = { eventId: id, occurredAt };
  const ignored: StripeParseResult = {
    ok: true,
    event: { type: "ignored", ...meta },
  };

  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const session = stripeCheckoutSessionSchema.safeParse(data.object);
      if (!session.success) return NOT_READABLE;
      if (session.data.mode !== "payment") return ignored;
      if (type === "checkout.session.expired")
        return {
          ok: true,
          event: paymentEventOfSession(
            session.data,
            meta,
            environment,
            "expired",
          ),
        };
      if (type === "checkout.session.async_payment_failed")
        return {
          ok: true,
          event: paymentEventOfSession(
            session.data,
            meta,
            environment,
            "failed",
          ),
        };
      // `completed` with an unpaid session is a delayed payment method: the money is not here yet.
      if (session.data.payment_status !== "paid") return ignored;
      return {
        ok: true,
        event: paymentEventOfSession(session.data, meta, environment, "paid"),
      };
    }
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return refundEvent(data.object, meta);
    case "charge.dispute.created":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      return disputeEvent(type, data.object, meta);
    default:
      return ignored;
  }
}
