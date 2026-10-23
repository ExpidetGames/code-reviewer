// SPDX-License-Identifier: Apache-2.0

// The provider-neutral billing adapter (ADR 0006, 2.12; #497). Money arrives through an adapter, never through code that
// knows a provider: an adapter performs actions at its provider and turns what the provider sends into the normalized
// events below, and it NEVER touches the journal. A generic layer (`apply-event.ts`) applies the events. The first real
// adapter is Stripe Managed Payments (#500 to #502); the `manual` adapter (`manual-adapter.ts`) lets a self-hosting
// operator run prepaid billing with no payment provider.
//
// Everything an adapter returns is untrusted data: an amount is a positive integer in micro-USD or the event is refused
// (`validateBillingEvent`), a reference is an opaque id (`isProviderRef`), and the credit is checked against our own
// top-up intent and the code constants before it is written. Refunds are an EVENT only: the interface has no way to
// refund, because the operator refunds in the provider's dashboard and the webhook books it (ADR 0006, section 7).
import "server-only";

/** The one currency of the ledger (ADR 0006, P8). */
export const BILLING_CURRENCY = "usd" as const;
export type BillingCurrency = typeof BILLING_CURRENCY;

const MICRO_USD = 1_000_000;

declare const usdBrand: unique symbol;

/**
 * Money of the ledger: a whole number of micro-USD (D1), never a float, never cents. Branded, so that cents, a provider's
 * amount in another currency and micro-USD cannot be mixed up by the type checker: `toUsd` is the way in. (The `amount`
 * of a refund or dispute is NOT `Usd`: it is the provider's own unit, see `RefundEvent`.)
 */
export type Usd = number & { readonly [usdBrand]: true };

/** A micro-USD amount from a number: a non-negative safe integer or `amount_out_of_range`. */
export function toUsd(value: number): Usd {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new BillingAdapterError(
      "amount_out_of_range",
      "an amount is a non-negative whole number of micro-USD",
    );
  return value as Usd;
}

declare const providerAmountBrand: unique symbol;

/**
 * An amount as the provider reports it: a positive whole number in ITS unit (a minor unit of the buyer's currency, tax
 * included). Only meaningful next to the amount of the whole payment in the same unit; it is never added to a ledger
 * amount. Branded like `Usd`, so a micro-USD value cannot be passed as a provider's amount (or the reverse) unseen:
 * `toProviderAmount` is the way in.
 */
export type ProviderAmount = number & { readonly [providerAmountBrand]: true };

/** A provider's amount from a number: a positive safe integer or `amount_out_of_range`. */
export function toProviderAmount(value: number): ProviderAmount {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BillingAdapterError(
      "amount_out_of_range",
      "a provider amount is a positive whole number",
    );
  return value as ProviderAmount;
}

/** A currency as a provider names it in an event: three lower case letters (an ISO 4217 code). */
export function isProviderCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{3}$/.test(value);
}

/** An opaque id at the provider (a payment, a checkout session, a refund, a dispute, a customer). No data. */
export type ProviderRef = string;

/** The ways the adapter layer refuses; stable, a caller branches on them. */
export const BILLING_ADAPTER_ERROR_CODES = [
  /** The capabilities are inconsistent or widen the range of the code constants. */
  "capabilities_invalid",
  /** An amount is outside the range of the adapter (and so of the code constants). */
  "amount_out_of_range",
  /** An adapter id is not lower case letters, digits, `_` or `-`. */
  "adapter_id_invalid",
  /** Two adapters share an id. */
  "adapter_id_duplicate",
  /** An adapter handed over an event that breaks the rules of a normalized event. */
  "event_invalid",
  /** A top-up at a provider that needs the buyer's customer object was started without one. */
  "customer_missing",
  /** The provider is not set up (no usable credential): nothing was sent. */
  "provider_not_configured",
  /** The provider did not answer in time, could not be reached, failed or is limiting the app: the request may be tried again. */
  "provider_unavailable",
  /** The provider refused the request, or answered with something the app cannot read: trying again will not help. */
  "provider_rejected",
  /** The provider did not accept the buyer's VAT ID. */
  "vat_id_rejected",
  /** The provider is still working on the very same request (a second click while the first runs): nothing is wrong. */
  "request_in_progress",
] as const;
export type BillingAdapterErrorCode =
  (typeof BILLING_ADAPTER_ERROR_CODES)[number];

export class BillingAdapterError extends Error {
  readonly code: BillingAdapterErrorCode;

  constructor(code: BillingAdapterErrorCode, message: string) {
    super(message);
    this.name = "BillingAdapterError";
    this.code = code;
  }
}

/** The top-up range of ADR 0006 (P7, D3): code constants. An adapter may narrow it, never widen it. */
export const TOP_UP_MIN_MICRO_USD = toUsd(10 * MICRO_USD);
export const TOP_UP_MAX_MICRO_USD = toUsd(500 * MICRO_USD);

/** Why an adapter does not accept a webhook. Only a code leaves the handler; nothing of the request does. */
export const BILLING_WEBHOOK_REJECTION_CODES = [
  /** No signature header, or an empty one. 401. */
  "signature_missing",
  /** The signature is malformed or does not match the exact bytes of the body. 401. */
  "signature_invalid",
  /** The signature is valid but the timestamp is outside the tolerance (a replay). 401. */
  "signature_expired",
  /** The signature is valid but the body is not an event the adapter can read. 400. */
  "body_invalid",
] as const;
export type BillingWebhookRejectionCode =
  (typeof BILLING_WEBHOOK_REJECTION_CODES)[number];

/** What the checkout of a top-up is: a page the buyer goes to, or none (the `manual` adapter). */
export type BillingCheckout =
  { kind: "redirect"; url: string } | { kind: "none" };

/**
 * What an adapter can do; the UI reads it so that the workspace page never names a provider. There is no auto-recharge
 * capability in v1 (ADR 0006, section 4).
 */
export type BillingCapabilities = {
  /** The provider is the seller of record and issues the buyer's invoice. */
  merchantOfRecord: boolean;
  /** The buyer may choose the amount (within the range). */
  customAmount: boolean;
  /** The provider can refund a part of a payment. */
  partialRefund: boolean;
  minTopUp: Usd;
  maxTopUp: Usd;
  currencies: readonly BillingCurrency[];
  /** The provider may refund or concede a dispute by itself within this window, whatever our policy is. */
  providerMayRefund: { windowDays: number } | null;
  /** A top-up goes through the provider's checkout page. False: there is none and the operator adds credit by hand. */
  checkout: boolean;
  /** A top-up needs the workspace's billing profile first. */
  requiresBillingProfile: boolean;
  /** Who issues receipts and invoices. */
  receiptsFrom: "provider" | "app";
};

/** The workspace an adapter acts for. Opaque to the adapter. */
export type WorkspaceRef = { id: string };

/** What the product keeps about the buyer, handed to a provider that needs it (#501). Customer data: never logged. */
export type BillingProfile = {
  readonly legalName: string;
  readonly country: string;
  readonly addressLines: readonly string[];
  readonly postalCode: string;
  readonly city: string;
  readonly vatId: string | null;
  readonly locale: string;
};

export interface BillingAdapter {
  /** Lower case letters, digits, `_` and `-`; the key of the registry and the `provider` of journal entries. */
  readonly id: string;
  readonly capabilities: BillingCapabilities;
  /**
   * Makes sure the provider knows the buyer, from the billing profile: creates the customer, or brings the one the
   * application holds (`customer`, the id it stored from an earlier call, or null) up to date; idempotent. A customer the
   * provider no longer knows is made again. Returns the id to store. `null` when the provider has no such object (the
   * `manual` adapter).
   */
  ensureCustomer(input: {
    workspace: WorkspaceRef;
    profile: BillingProfile;
    customer: ProviderRef | null;
  }): Promise<ProviderRef | null>;
  /**
   * Starts a top-up for an intent the application wrote FIRST (the intent id is the idempotency key at the provider and
   * the reference the provider echoes back). The amount was checked against the range (`assertTopUpAmount`). `session`
   * and `payment` are the provider ids when they are already known; the application records them on the intent.
   */
  createTopUpCheckout(input: {
    customer: ProviderRef | null;
    intentId: string;
    amount: Usd;
    returnUrl: string;
  }): Promise<{
    checkout: BillingCheckout;
    session: ProviderRef | null;
    payment: ProviderRef | null;
  }>;
  /**
   * Asks the provider about the page of a top-up that has one already (`createTopUpCheckout` returned its `session`): the
   * address while the buyer can still use it, or `closed` (paid, expired, or unknown to the provider). Never makes a page,
   * so a repeat of a start after the provider forgot its idempotency key cannot make a second one for the same intent.
   * Absent when the adapter has no checkout.
   */
  resumeTopUpCheckout?(input: {
    checkout: ProviderRef;
  }): Promise<{ kind: "open"; url: string } | { kind: "closed" }>;
  /**
   * Checks the signature of a webhook over the exact bytes of its body and parses it into ONE normalized event. A body
   * is data until its signature is verified. `rawBody` is the bytes as received, not decoded text: a signature is a MAC
   * over bytes, and decoding drops a byte order mark and replaces bytes that are not UTF-8. The adapter decodes the body
   * itself, after the check. Makes no outbound call and touches no database. Absent when the provider sends no webhooks
   * (the `manual` adapter): the route answers the missing path.
   *
   * One event per delivery: a provider delivery that lists several refunds (or disputes) is mapped to the per-object
   * event of the provider (Stripe's `refund.created`/`refund.updated`/`refund.failed`, not the `charge.refunded` list),
   * so each refund arrives under its own event id and refund id. An adapter must not read a CUMULATIVE amount (Stripe's
   * `amount_refunded` of a charge) as the amount of one refund; the caps of the intent (`apply-event.ts`) are the net
   * under that mistake, not a licence for it.
   */
  verifyAndParseWebhook?(input: {
    headers: Headers;
    rawBody: Uint8Array;
    now: Date;
  }): Promise<WebhookResult>;
  /**
   * Asks the provider what became of a top-up and returns it as a normalized payment event (`payment.succeeded`,
   * `payment.refused`, `payment.failed` or `payment.expired`), or null when the provider knows nothing of it (yet) or the object is gone
   * (a `resource_missing` is normal, never an error). It is the one outbound call of the adapter, made in a user's
   * request (#502's "Check payment"), never in the webhook; the event goes through `applyBillingEvent` like a webhook's,
   * so a lost webhook, a late one and a click are idempotent together. Absent when the provider cannot be asked (the
   * `manual` adapter).
   */
  lookupTopUp?(input: {
    intentId: string;
    checkout: ProviderRef | null;
    payment: ProviderRef | null;
  }): Promise<TopUpLookupEvent | null>;
  /**
   * The newest invoices of THE customer the application stored for the workspace (`customer`, never a free filter), newest
   * first, drafts left out (#659). The one outbound read of the billing page, made in a user's request. Absent when the
   * provider issues no invoices the app can list (the `manual` adapter).
   */
  listInvoices?(input: { customer: ProviderRef }): Promise<InvoiceSummary[]>;
}

/**
 * An invoice of the workspace as the provider shows it (#659): plain data for the billing page. The amount is the provider's
 * own unit (cents of `currency`), the two addresses are the provider's hosted page and PDF, already checked to be web addresses.
 * A draft is never listed.
 */
export type InvoiceSummary = {
  /** The provider's id of the invoice: a stable key, nothing else. */
  id: ProviderRef;
  /** The invoice number the buyer sees, when there is one. */
  number: string | null;
  createdAt: string;
  amount: ProviderAmount;
  currency: string;
  status: "paid" | "open" | "void" | "uncollectible";
  /** The provider's page of the invoice, and its PDF. */
  viewUrl: string | null;
  downloadUrl: string | null;
};

/** What a lookup of a top-up may answer. */
export type TopUpLookupEvent = Extract<
  BillingEvent,
  {
    type:
      | "payment.succeeded"
      | "payment.refused"
      | "payment.failed"
      | "payment.expired";
  }
>;

export type WebhookResult =
  | { ok: true; event: BillingEvent }
  | { ok: false; code: BillingWebhookRejectionCode };

/** Who started a refund, as far as the provider says. */
export const REFUND_INITIATORS = ["seller", "provider", "customer"] as const;
export type RefundInitiator = (typeof REFUND_INITIATORS)[number];

/**
 * `pending` and `approved`: the money is leaving, the journal is debited. `rejected` and `reversed`: it is not leaving
 * (any more), a debit written before is reversed once.
 */
export const REFUND_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "reversed",
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * `opened` and `lost`: the provider took the money (it does so when a dispute opens), the journal is debited, once.
 * `won`: it comes back, the debit is reversed once.
 *
 * What the adapter maps to them (the mapping the Stripe adapter of #502 documents in the same words):
 *   - `opened`  the dispute is created, or the funds are withdrawn (`charge.dispute.created`, `funds_withdrawn`);
 *   - `lost`    the dispute is closed and lost (`charge.dispute.closed` with the status `lost`);
 *   - `won`     the dispute is closed and won, or the funds are reinstated, or the dispute is closed because the charge
 *               was refunded (`charge.dispute.closed` with `won` or `charge_refunded`, `funds_reinstated`): the
 *               disputed money comes back, and a refund, if any, is its own event;
 *   - nothing   an early warning that moves no money (`warning_needs_response`, `warning_under_review`,
 *               `warning_closed`) and a dispute still under review: the event is `ignored`.
 */
export const DISPUTE_STATUSES = ["opened", "lost", "won"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

type EventBase = {
  /** The provider's id of the delivery or event: the first idempotency layer. */
  eventId: string;
  /** When it happened at the provider, ISO 8601: the order of the states of one refund or dispute. */
  occurredAt: string;
};

/**
 * What an adapter hands to the application. Provider-neutral.
 *
 *   - A PAYMENT carries OUR ledger amounts: `creditable` is net of tax, in micro-USD (`Usd`); `gross` and `tax` are for
 *     the record. The adapter converts; the provider's net is the basis of the credit.
 *   - A REFUND or DISPUTE carries the PROVIDER's amounts, gross, as the provider reports them: `amount` of this refund
 *     or dispute and `paymentAmount` of the whole payment, both in the SAME unit (cents in the buyer's currency, say; the
 *     unit never matters). The provider says nothing of the tax split of a refund, so the application takes the net
 *     share from the ratio under the intent lock (`netShareMicroUsd`): `credited x amount / paymentAmount`.
 *   - `payment.expired` is the end of a checkout nobody paid (the checkout session expired): the intent leaves `pending`.
 *   - `ignored` is a verified event of a type the adapter does not use: it is recorded and does nothing.
 */
export type BillingEvent =
  | (EventBase & {
      type: "payment.succeeded";
      /** The reference WE put on the checkout (our intent id) when the provider echoes it, else null. */
      intentId: string | null;
      payment: ProviderRef;
      checkout: ProviderRef | null;
      /** What becomes credit: the net amount. */
      creditable: Usd;
      gross: Usd;
      /** Zero is a real tax (a buyer who owes none); null is "the provider does not say". */
      tax: Usd | null;
      /**
       * What the buyer was charged, gross, in the PROVIDER's unit (the unit its refunds and disputes use: cents of the
       * currency the buyer paid in). The application pins it on the intent when it credits, so a refund or dispute event
       * that carries only its own `amount` (Stripe's does) is related to the whole payment without asking the provider.
       * Absent when the provider does not say.
       */
      providerAmount?: ProviderAmount;
      /**
       * The currency of `providerAmount` (lower case ISO 4217), pinned with it. A refund or dispute names its own currency,
       * and an amount in another currency than the charge is no share of it (`amount_rejected`). Absent when the provider
       * does not say (then its refunds and disputes carry no currency either).
       */
      providerCurrency?: string;
    })
  | (EventBase & {
      /**
       * A payment the adapter reads as paid and refuses to turn into credit because it contradicts what we asked for
       * (another currency, the other environment, a reference that disagrees with itself, an amount that is no amount).
       * Nothing is credited; the event is recorded `amount_rejected` for review: a buyer may have paid and got nothing.
       */
      type: "payment.refused";
      payment: ProviderRef | null;
      /** Our intent id when the session names one: lets the review say whose payment it is, nothing more. */
      intentId?: string | null;
    })
  | (EventBase & {
      type: "payment.failed";
      intentId: string | null;
      payment: ProviderRef | null;
      checkout: ProviderRef | null;
    })
  | (EventBase & {
      type: "payment.expired";
      intentId: string | null;
      payment: ProviderRef | null;
      checkout: ProviderRef | null;
    })
  | (EventBase & {
      type: "refund.updated";
      payment: ProviderRef;
      refund: ProviderRef;
      /** THIS refund, gross, in the provider's unit (the same as `paymentAmount`): positive whole number. */
      amount: ProviderAmount;
      /**
       * The whole payment it refunds, gross, in the same unit, when the provider's event says (Stripe's refund does not:
       * the application then takes the amount it pinned from the payment, `providerAmount`). When both exist and differ,
       * the event is `amount_conflict`.
       */
      paymentAmount?: ProviderAmount;
      /** The currency of `amount` (lower case): it must be the one the payment was pinned in. Absent: the provider does not say. */
      currency?: string;
      initiatedBy: RefundInitiator;
      status: RefundStatus;
    })
  | (EventBase & {
      type: "dispute.updated";
      payment: ProviderRef;
      dispute: ProviderRef;
      /** The disputed amount, gross, in the provider's unit (the same as `paymentAmount`). */
      amount: ProviderAmount;
      /** As for a refund: absent when the provider's event does not carry it. */
      paymentAmount?: ProviderAmount;
      /** As for a refund. */
      currency?: string;
      status: DisputeStatus;
    })
  | (EventBase & { type: "ignored" });

export const BILLING_EVENT_TYPES = [
  "payment.succeeded",
  "payment.refused",
  "payment.failed",
  "payment.expired",
  "refund.updated",
  "dispute.updated",
  "ignored",
] as const satisfies readonly BillingEvent["type"][];

/** What came of an event; stored in `billing_webhook_events`, so a value is never renamed or reused. */
export const BILLING_EVENT_OUTCOMES = [
  /** The journal or an intent changed. */
  "applied",
  /** Nothing changed: the event id was seen, or its effect exists already (the payment reference is the key). */
  "duplicate_ignored",
  /** An older state of a refund or dispute than the last one applied. */
  "stale_ignored",
  /** No top-up intent of ours belongs to the event. Nothing changed; the provider is answered 200. */
  "intent_unresolved",
  /** A verified event of a type the application does not use. */
  "ignored_type",
  /** A rejected refund or a won dispute with no debit to reverse (yet). */
  "nothing_to_reverse",
  /** The amount is outside what our own intent allows; nothing was credited or debited. */
  "amount_rejected",
  /** The reference exists in the journal with another amount; nothing was changed. */
  "amount_conflict",
  /** A payment arrived for a workspace that was deleted (#658); nothing was credited, an operator refunds it. */
  "workspace_deleted",
  /** A signed event that is not a normalized event (an adapter bug or a provider change). Nothing was changed. */
  "event_invalid",
] as const;
export type BillingEventOutcome = (typeof BILLING_EVENT_OUTCOMES)[number];

/**
 * The outcomes of an event that moved money, or claimed to, and changed nothing in the ledger: a buyer may have paid and
 * got nothing, or been refunded and kept the credit. Each is recorded `review_state = 'open'`, logged at error level and
 * answered 200 (the provider's retry would not change it). The repair is the operator's: a `manual` grant or correction
 * (#504), or "Check payment" (#502) when the provider's state is the doubt. Benign outcomes (`duplicate_ignored`,
 * `stale_ignored`, `nothing_to_reverse`, `ignored_type`) are not in the set.
 */
export const BILLING_REVIEW_OUTCOMES = [
  "intent_unresolved",
  "amount_rejected",
  "amount_conflict",
  "workspace_deleted",
  "event_invalid",
] as const satisfies readonly BillingEventOutcome[];
export type BillingReviewOutcome = (typeof BILLING_REVIEW_OUTCOMES)[number];

const ADAPTER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDER_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isUsdAmount(value: unknown): value is Usd {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A tax: zero (a buyer who owes none) or a positive amount. */
function isTaxAmount(value: unknown): value is Usd {
  return value === 0 || isUsdAmount(value);
}

export function isProviderAmount(value: unknown): value is ProviderAmount {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isProviderRef(value: unknown): value is ProviderRef {
  return typeof value === "string" && PROVIDER_REF.test(value);
}

export function isAdapterId(value: unknown): value is string {
  return typeof value === "string" && ADAPTER_ID.test(value);
}

/**
 * Throws `capabilities_invalid` when the capabilities contradict themselves or the code constants: a range wider than 10
 * to 500, a minimum above the maximum, no currency or one that is not USD, a refund window that is not a positive whole
 * number of days.
 */
export function assertValidCapabilities(
  id: string,
  capabilities: BillingCapabilities,
): void {
  const refuse = (why: string): never => {
    throw new BillingAdapterError(
      "capabilities_invalid",
      `adapter ${id}: ${why}`,
    );
  };
  const { minTopUp, maxTopUp } = capabilities;
  if (!isUsdAmount(minTopUp) || !isUsdAmount(maxTopUp))
    refuse("the range is not made of positive integer amounts");
  if (minTopUp > maxTopUp) refuse("the minimum is above the maximum");
  if (minTopUp < TOP_UP_MIN_MICRO_USD || maxTopUp > TOP_UP_MAX_MICRO_USD)
    refuse("an adapter may narrow the top-up range, never widen it");
  if (
    capabilities.currencies.length === 0 ||
    capabilities.currencies.some((currency) => currency !== BILLING_CURRENCY)
  )
    refuse("the ledger is USD");
  const window = capabilities.providerMayRefund;
  if (
    window !== null &&
    !(Number.isSafeInteger(window.windowDays) && window.windowDays > 0)
  )
    refuse("the refund window is a positive number of days");
}

/** Throws `amount_out_of_range` unless the amount is a whole micro-USD amount inside the range of the adapter. */
export function assertTopUpAmount(
  capabilities: BillingCapabilities,
  amount: number,
): void {
  const low = Math.max(capabilities.minTopUp, TOP_UP_MIN_MICRO_USD);
  const high = Math.min(capabilities.maxTopUp, TOP_UP_MAX_MICRO_USD);
  if (!isUsdAmount(amount) || amount < low || amount > high)
    throw new BillingAdapterError(
      "amount_out_of_range",
      "the top-up amount is outside the allowed range",
    );
}

export type AdapterRegistry = {
  get(id: string): BillingAdapter | undefined;
  ids(): string[];
};

/** The adapters of an instance, keyed by id. A bad id, a duplicate or inconsistent capabilities fail at startup. */
export function createAdapterRegistry(
  adapters: readonly BillingAdapter[],
): AdapterRegistry {
  const byId = new Map<string, BillingAdapter>();
  for (const adapter of adapters) {
    if (!isAdapterId(adapter.id))
      throw new BillingAdapterError(
        "adapter_id_invalid",
        "an adapter id is lower case letters, digits, _ and -",
      );
    if (byId.has(adapter.id))
      throw new BillingAdapterError(
        "adapter_id_duplicate",
        `two adapters share the id ${adapter.id}`,
      );
    assertValidCapabilities(adapter.id, adapter.capabilities);
    byId.set(adapter.id, adapter);
  }
  return {
    get: (id) => byId.get(id),
    ids: () => [...byId.keys()],
  };
}

function refuseEvent(why: string): never {
  throw new BillingAdapterError("event_invalid", why);
}

function requireRef(value: unknown, what: string): void {
  if (!isProviderRef(value)) refuseEvent(`${what} is not an opaque id`);
}

function requireOptionalRef(value: unknown, what: string): void {
  if (value !== null) requireRef(value, what);
}

function requireAmount(value: unknown, what: string): void {
  if (!isUsdAmount(value)) refuseEvent(`${what} is not a positive integer`);
}

function requireProviderAmount(value: unknown, what: string): void {
  if (!isProviderAmount(value))
    refuseEvent(`${what} is not a positive integer`);
}

function requireOptionalProviderAmount(value: unknown, what: string): void {
  if (value !== undefined) requireProviderAmount(value, what);
}

function requireOptionalCurrency(value: unknown, what: string): void {
  if (value !== undefined && !isProviderCurrency(value))
    refuseEvent(`${what} is not a lower case currency code`);
}

/**
 * Throws `event_invalid` when an adapter hands over something that is not a normalized event: an adapter is code, but
 * what it reads is a provider's data, and nothing past this function trusts an amount, a reference or a status that did
 * not pass it. (A well formed amount can still be refused later against our intent: `amount_rejected`.)
 */
export function validateBillingEvent(event: BillingEvent): void {
  if (typeof event !== "object" || event === null || Array.isArray(event))
    refuseEvent("not an event");
  if (!BILLING_EVENT_TYPES.includes(event.type))
    refuseEvent("unknown event type");
  requireRef(event.eventId, "the event id");
  if (
    typeof event.occurredAt !== "string" ||
    !ISO_TIME.test(event.occurredAt) ||
    Number.isNaN(Date.parse(event.occurredAt))
  )
    refuseEvent("the time is not ISO 8601");
  switch (event.type) {
    case "ignored":
      return;
    case "payment.succeeded":
      requireOptionalRef(event.intentId, "the intent id");
      requireRef(event.payment, "the payment");
      requireOptionalRef(event.checkout, "the checkout");
      requireAmount(event.creditable, "the creditable amount");
      requireAmount(event.gross, "the gross amount");
      if (event.tax !== null && !isTaxAmount(event.tax))
        refuseEvent("the tax is not a non-negative integer");
      requireOptionalProviderAmount(event.providerAmount, "the payment amount");
      requireOptionalCurrency(event.providerCurrency, "the payment currency");
      return;
    case "payment.refused":
      requireOptionalRef(event.payment, "the payment");
      if (event.intentId !== undefined)
        requireOptionalRef(event.intentId, "the intent id");
      return;
    case "payment.failed":
    case "payment.expired":
      requireOptionalRef(event.intentId, "the intent id");
      requireOptionalRef(event.payment, "the payment");
      requireOptionalRef(event.checkout, "the checkout");
      return;
    case "refund.updated":
      requireRef(event.payment, "the payment");
      requireRef(event.refund, "the refund");
      requireProviderAmount(event.amount, "the refund amount");
      requireOptionalProviderAmount(event.paymentAmount, "the payment amount");
      requireOptionalCurrency(event.currency, "the refund currency");
      if (!REFUND_INITIATORS.includes(event.initiatedBy))
        refuseEvent("unknown refund initiator");
      if (!REFUND_STATUSES.includes(event.status))
        refuseEvent("unknown refund status");
      return;
    case "dispute.updated":
      requireRef(event.payment, "the payment");
      requireRef(event.dispute, "the dispute");
      requireProviderAmount(event.amount, "the dispute amount");
      requireOptionalProviderAmount(event.paymentAmount, "the payment amount");
      requireOptionalCurrency(event.currency, "the dispute currency");
      if (!DISPUTE_STATUSES.includes(event.status))
        refuseEvent("unknown dispute status");
      return;
  }
}
