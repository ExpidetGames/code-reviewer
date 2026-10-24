// SPDX-License-Identifier: LicenseRef-Proprietary

// The state of the fake Stripe and the things that happen to it: customers, Checkout sessions, payment intents, charges,
// refunds, disputes, webhook endpoints and the events they make. The objects are copies of the fixtures with the fields
// of the request set; an event holds a snapshot of its object as it was then. Nothing here knows about HTTP.
import { invalidRequest, noSuch } from "./errors.ts";
import { loadStripeFixture } from "./fixtures.ts";
import { createIds } from "./ids.ts";

export type FakeObject = Record<string, unknown> & { id: string };

/** Who caused an event: an API request (its id and idempotency key), or nobody we know of (Stripe, the buyer). */
export type EventCause = {
  requestId: string | null;
  idempotencyKey: string | null;
};
export const NO_REQUEST: EventCause = { requestId: null, idempotencyKey: null };

export type StripeEvent = {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  data: { object: FakeObject };
  livemode: false;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: string;
};

export type FakeEndpoint = FakeObject & {
  url: string;
  enabled_events: string[];
  status: "enabled" | "disabled";
};

export const STRIPE_FAKE_API_VERSION = "2025-03-31.basil";
const SESSION_LIFETIME_SECONDS = 86_400;

/** The event types the fake knows, for `enabled_events` (an unknown one is refused, as at Stripe). */
export const KNOWN_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "payment_intent.created",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.succeeded",
  "charge.failed",
  "charge.updated",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "customer.created",
  "customer.updated",
  "customer.deleted",
] as const;

const cents = (amount: number) => (amount / 100).toFixed(2);

export function createStore(options: { now: () => number }) {
  const ids = createIds();
  const seconds = () => Math.floor(options.now() / 1000);

  const customers = new Map<string, FakeObject>();
  const deletedCustomers = new Set<string>();
  const taxIds = new Map<string, FakeObject[]>();
  const sessions = new Map<string, FakeObject>();
  const paymentIntents = new Map<string, FakeObject>();
  const charges = new Map<string, FakeObject>();
  const invoices = new Map<string, FakeObject>();
  let invoiceCustomerFilterIgnored = false;
  const refunds = new Map<string, FakeObject>();
  const disputes = new Map<string, FakeObject>();
  const endpoints = new Map<string, FakeEndpoint>();
  const secrets = new Map<string, string>();
  const events: StripeEvent[] = [];
  /** Per event and endpoint: how often it was sent and whether the receiver took it (a 2xx). */
  const deliveries = new Map<
    string,
    { attempts: number; delivered: boolean }
  >();

  const snapshot = <T>(value: T): T => structuredClone(value);

  function subscribed(endpoint: FakeEndpoint, type: string): boolean {
    return (
      endpoint.status === "enabled" &&
      (endpoint.enabled_events.includes("*") ||
        endpoint.enabled_events.includes(type))
    );
  }

  function emit(
    type: string,
    object: FakeObject,
    cause: EventCause,
  ): StripeEvent {
    const fixture = loadStripeFixture("event");
    const event = {
      ...fixture,
      id: ids.next("evt"),
      object: "event",
      api_version: STRIPE_FAKE_API_VERSION,
      created: seconds(),
      data: { object: snapshot(object) },
      livemode: false,
      pending_webhooks: [...endpoints.values()].filter((endpoint) =>
        subscribed(endpoint, type),
      ).length,
      request: { id: cause.requestId, idempotency_key: cause.idempotencyKey },
      type,
    } as StripeEvent;
    events.push(event);
    return event;
  }

  function copyOf(
    name: Parameters<typeof loadStripeFixture>[0],
    id: string,
    patch: Record<string, unknown>,
  ): FakeObject {
    return { ...loadStripeFixture(name), id, ...patch } as FakeObject;
  }

  // --- customers

  function customer(id: string): FakeObject | "deleted" {
    if (deletedCustomers.has(id)) return "deleted";
    const found = customers.get(id);
    if (found === undefined) throw noSuch("customer", id, "id");
    return found;
  }

  function existingCustomer(
    id: string,
    param: string,
    status: 400 | 404,
  ): FakeObject {
    const found = customers.get(id);
    if (found === undefined || deletedCustomers.has(id))
      throw noSuch("customer", id, param, status);
    return found;
  }

  function addTaxId(
    customerId: string,
    input: { type: string; value: string },
  ): FakeObject {
    const taxId = copyOf("tax-id", ids.next("txi"), {
      customer: customerId,
      owner: { customer: customerId, customer_account: null, type: "customer" },
      type: input.type,
      value: input.value,
      created: seconds(),
    });
    taxIds.set(customerId, [...(taxIds.get(customerId) ?? []), taxId]);
    return taxId;
  }

  // --- refunds, shared by the API and by "Stripe"

  function chargeOfRefund(input: {
    charge?: string;
    paymentIntent?: string;
  }): FakeObject {
    if (input.charge !== undefined) {
      const found = charges.get(input.charge);
      if (found === undefined) throw noSuch("charge", input.charge, "id");
      return found;
    }
    const intentId = input.paymentIntent ?? "";
    const intent = paymentIntents.get(intentId);
    if (intent === undefined)
      throw noSuch("payment_intent", intentId, "payment_intent");
    const chargeId = intent.latest_charge;
    const found =
      typeof chargeId === "string" ? charges.get(chargeId) : undefined;
    if (found === undefined)
      throw invalidRequest(
        `This PaymentIntent (${intentId}) does not have a successful charge to refund.`,
        { param: "payment_intent" },
      );
    return found;
  }

  function refund(
    input: {
      charge?: string;
      paymentIntent?: string;
      amount?: number;
      reason?: string;
      metadata?: Record<string, string>;
    },
    cause: EventCause,
  ): { refund: FakeObject; charge: FakeObject } {
    const charge = chargeOfRefund(input);
    const total = charge.amount as number;
    const already = charge.amount_refunded as number;
    if (already >= total)
      throw invalidRequest(`Charge ${charge.id} has already been refunded.`, {
        code: "charge_already_refunded",
        param: "charge",
      });
    const amount = input.amount ?? total - already;
    if (!Number.isInteger(amount) || amount < 1)
      throw invalidRequest("Invalid positive integer", { param: "amount" });
    if (amount > total - already)
      throw invalidRequest(
        `Refund amount ($${cents(amount)}) is greater than unrefunded amount on charge ($${cents(total - already)})`,
        { param: "amount" },
      );
    const created = copyOf("refund", ids.next("re"), {
      amount,
      charge: charge.id,
      payment_intent: charge.payment_intent,
      currency: charge.currency,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      created: seconds(),
      status: "succeeded",
    });
    refunds.set(created.id, created);
    charge.amount_refunded = already + amount;
    charge.refunded = charge.amount_refunded === total;
    emit("charge.refunded", charge, cause);
    emit("refund.created", created, cause);
    return { refund: created, charge };
  }

  return {
    ids,
    seconds,
    snapshot,
    emit,
    subscribed,
    maps: {
      customers,
      taxIds,
      sessions,
      paymentIntents,
      charges,
      invoices,
      refunds,
      disputes,
      endpoints,
    },
    events,
    deliveries,
    secretOf: (endpointId: string) => secrets.get(endpointId),

    // customers
    createCustomer(
      params: Record<string, unknown>,
      taxIdData: Array<{ type: string; value: string }>,
      cause: EventCause,
    ): FakeObject {
      const created = copyOf("customer", ids.next("cus"), {
        ...params,
        created: seconds(),
      });
      customers.set(created.id, created);
      for (const entry of taxIdData) addTaxId(created.id, entry);
      emit("customer.created", created, cause);
      return created;
    },
    getCustomer: customer,
    updateCustomer(
      id: string,
      patch: Record<string, unknown>,
      cause: EventCause,
    ): FakeObject {
      const found = existingCustomer(id, "id", 404);
      Object.assign(found, patch);
      emit("customer.updated", found, cause);
      return found;
    },
    /** Stripe deletes a customer when the buyer asks for their data to go: the object answers `deleted: true` after. */
    deleteCustomer(id: string, cause: EventCause = NO_REQUEST): void {
      const found = existingCustomer(id, "id", 404);
      deletedCustomers.add(id);
      customers.delete(id);
      taxIds.delete(id);
      emit("customer.deleted", found, cause);
    },
    existingCustomer,
    addTaxId,
    taxIdsOf: (customerId: string) => taxIds.get(customerId) ?? [],
    deleteTaxId(customerId: string, taxIdId: string): void {
      existingCustomer(customerId, "id", 404);
      const list = taxIds.get(customerId) ?? [];
      if (!list.some((entry) => entry.id === taxIdId))
        throw noSuch("tax id", taxIdId, "id");
      taxIds.set(
        customerId,
        list.filter((entry) => entry.id !== taxIdId),
      );
    },

    // Checkout sessions
    createSession(
      input: {
        lineItems: Array<{ quantity: number; unitAmount: number }>;
        currency: string;
        params: Record<string, unknown>;
      },
      origin: string,
      cause: EventCause,
    ): FakeObject {
      const id = ids.next("cs_test");
      const subtotal = input.lineItems.reduce(
        (sum, item) => sum + item.quantity * item.unitAmount,
        0,
      );
      const created = seconds();
      const session = copyOf("checkout-session", id, {
        ...input.params,
        created,
        expires_at:
          (input.params.expires_at as number | undefined) ??
          created + SESSION_LIFETIME_SECONDS,
        currency: input.currency,
        amount_subtotal: subtotal,
        amount_total: subtotal,
        url: `${origin}/c/pay/${id}`,
      });
      sessions.set(id, session);
      return session;
    },
    getSession(id: string): FakeObject {
      const found = sessions.get(id);
      if (found === undefined) throw noSuch("checkout.session", id, "session");
      return found;
    },
    expireSession(id: string, cause: EventCause): FakeObject {
      const session = sessions.get(id);
      if (session === undefined)
        throw noSuch("checkout.session", id, "session");
      if (session.status !== "open")
        throw invalidRequest(
          "Only Checkout Sessions with a status in (open) can be expired.",
          { param: "session" },
        );
      session.status = "expired";
      session.url = null;
      emit("checkout.session.expired", session, cause);
      return session;
    },

    // the buyer
    pay(
      sessionId: string,
      options: {
        taxAmount?: number;
        /** A discount taken off the subtotal, in cents (a coupon or a promotion code). */
        discountAmount?: number;
        charged?: { currency: string; amount: number };
      } = {},
    ): { session: FakeObject; paymentIntent: FakeObject; charge: FakeObject } {
      const session = sessions.get(sessionId);
      if (session === undefined)
        throw noSuch("checkout.session", sessionId, "session");
      if (session.status !== "open")
        throw invalidRequest(
          `The Checkout Session ${sessionId} is not open and cannot be paid.`,
          { param: "session" },
        );
      const tax = options.taxAmount ?? 0;
      const discount = options.discountAmount ?? 0;
      const total = (session.amount_subtotal as number) - discount + tax;
      const amount = options.charged?.amount ?? total;
      const currency =
        options.charged?.currency ?? (session.currency as string);
      const intent = copyOf("payment-intent", ids.next("pi"), {
        amount,
        amount_received: amount,
        currency,
        customer: session.customer,
        created: seconds(),
        status: "succeeded",
        managed_payments: session.managed_payments,
      });
      const charge = copyOf("charge", ids.next("ch"), {
        amount,
        amount_captured: amount,
        currency,
        customer: session.customer,
        payment_intent: intent.id,
        created: seconds(),
      });
      intent.latest_charge = charge.id;
      paymentIntents.set(intent.id, intent);
      charges.set(charge.id, charge);
      // Managed Payments: Stripe, the seller of record, issues the buyer's invoice; the app asks for none (`invoice_creation` is
      // refused). It belongs to the customer of the session and carries the page and the PDF Stripe hosts. NOT recorded against
      // the sandbox (maintainer task #503): that a Managed Payments payment leaves an Invoice object is this fake's assumption.
      if (typeof session.customer === "string") {
        const invoice = copyOf("invoice", ids.next("in"), {
          amount_due: total,
          amount_paid: total,
          total,
          currency,
          customer: session.customer,
          payment_intent: intent.id,
          created: seconds(),
          number: `FAKE-${String(invoices.size + 1).padStart(4, "0")}`,
          status: "paid",
          hosted_invoice_url: `${new URL(String(session.url)).origin}/i/${intent.id}`,
          invoice_pdf: `${new URL(String(session.url)).origin}/i/${intent.id}/pdf`,
        });
        invoices.set(invoice.id, invoice);
      }
      session.status = "complete";
      session.payment_status = "paid";
      session.payment_intent = intent.id;
      session.amount_total = total;
      session.total_details = {
        amount_discount: discount,
        amount_shipping: 0,
        amount_tax: tax,
      };
      // Adaptive Pricing (API version 2025-03-31 and later): the session stays in our currency and says what the buyer paid.
      if (options.charged !== undefined)
        session.presentment_details = {
          presentment_amount: options.charged.amount,
          presentment_currency: options.charged.currency,
        };
      session.url = null;
      emit("payment_intent.succeeded", intent, NO_REQUEST);
      emit("charge.succeeded", charge, NO_REQUEST);
      emit("checkout.session.completed", session, NO_REQUEST);
      return { session, paymentIntent: intent, charge };
    },
    /** A delayed payment method that fails after the buyer has left: the session completes unpaid, then fails. */
    failAsync(sessionId: string): {
      session: FakeObject;
      paymentIntent: FakeObject;
    } {
      const session = sessions.get(sessionId);
      if (session === undefined)
        throw noSuch("checkout.session", sessionId, "session");
      if (session.status !== "open")
        throw invalidRequest(
          `The Checkout Session ${sessionId} is not open and cannot be paid.`,
          { param: "session" },
        );
      const intent = copyOf("payment-intent", ids.next("pi"), {
        amount: session.amount_total,
        currency: session.currency,
        customer: session.customer,
        created: seconds(),
        status: "requires_payment_method",
      });
      paymentIntents.set(intent.id, intent);
      session.status = "complete";
      session.payment_status = "unpaid";
      session.payment_intent = intent.id;
      session.url = null;
      emit("checkout.session.async_payment_failed", session, NO_REQUEST);
      return { session, paymentIntent: intent };
    },

    // payment intents and charges
    getPaymentIntent(id: string): FakeObject {
      const found = paymentIntents.get(id);
      if (found === undefined) throw noSuch("payment_intent", id, "intent");
      return found;
    },
    /** An invoice Stripe made on its own (a draft, one still open, one voided): no request of the app is behind it. */
    addInvoice(patch: Record<string, unknown>): FakeObject {
      const invoice = copyOf("invoice", ids.next("in"), {
        created: seconds(),
        ...patch,
      });
      invoices.set(invoice.id, invoice);
      return invoice;
    },
    /** A bad day of Stripe: the list of invoices forgets its `customer` filter and answers every customer's invoices. */
    ignoreInvoiceCustomerFilter(ignored: boolean): void {
      invoiceCustomerFilterIgnored = ignored;
    },
    invoiceCustomerFilterIgnored(): boolean {
      return invoiceCustomerFilterIgnored;
    },
    getInvoice(id: string): FakeObject {
      const found = invoices.get(id);
      if (found === undefined) throw noSuch("invoice", id, "invoice");
      return found;
    },
    getCharge(id: string): FakeObject {
      const found = charges.get(id);
      if (found === undefined) throw noSuch("charge", id, "id");
      return found;
    },

    // refunds
    refund,
    getRefund(id: string): FakeObject {
      const found = refunds.get(id);
      if (found === undefined) throw noSuch("refund", id, "refund");
      return found;
    },
    failRefund(
      id: string,
      cause: EventCause = NO_REQUEST,
    ): { refund: FakeObject; charge: FakeObject } {
      const found = refunds.get(id);
      if (found === undefined) throw noSuch("refund", id, "refund");
      if (found.status !== "succeeded" && found.status !== "pending")
        throw invalidRequest(
          `The refund ${id} is already ${String(found.status)}.`,
        );
      const charge = charges.get(found.charge as string) as FakeObject;
      found.status = "failed";
      found.failure_reason = "unknown";
      charge.amount_refunded =
        (charge.amount_refunded as number) - (found.amount as number);
      charge.refunded = false;
      emit("refund.updated", found, cause);
      emit("refund.failed", found, cause);
      return { refund: found, charge };
    },

    // disputes
    openDispute(
      chargeId: string,
      options: { amount?: number; reason?: string } = {},
    ): { dispute: FakeObject; charge: FakeObject } {
      const charge = charges.get(chargeId);
      if (charge === undefined) throw noSuch("charge", chargeId, "charge");
      const dispute = copyOf("dispute", ids.next("dp"), {
        amount: options.amount ?? charge.amount,
        currency: charge.currency,
        charge: charge.id,
        payment_intent: charge.payment_intent,
        reason: options.reason ?? "general",
        created: seconds(),
        status: "needs_response",
      });
      disputes.set(dispute.id, dispute);
      charge.disputed = true;
      emit("charge.dispute.created", dispute, NO_REQUEST);
      emit("charge.dispute.funds_withdrawn", dispute, NO_REQUEST);
      return { dispute, charge };
    },
    closeDispute(id: string, outcome: "won" | "lost"): FakeObject {
      const dispute = disputes.get(id);
      if (dispute === undefined) throw noSuch("dispute", id, "dispute");
      if (dispute.status === "won" || dispute.status === "lost")
        throw invalidRequest(`The dispute ${id} is already closed.`);
      dispute.status = outcome;
      emit("charge.dispute.closed", dispute, NO_REQUEST);
      if (outcome === "won")
        emit("charge.dispute.funds_reinstated", dispute, NO_REQUEST);
      return dispute;
    },

    // webhook endpoints
    createEndpoint(params: {
      url: string;
      enabled_events: string[];
      description?: string;
      api_version?: string;
      metadata?: Record<string, string>;
    }): FakeEndpoint {
      const id = ids.next("we");
      const endpoint = copyOf("webhook-endpoint", id, {
        url: params.url,
        enabled_events: params.enabled_events,
        description: params.description ?? null,
        api_version: params.api_version ?? null,
        metadata: params.metadata ?? {},
        created: seconds(),
      }) as FakeEndpoint;
      endpoints.set(id, endpoint);
      secrets.set(id, `${ids.next("whsec")}FakeSigningSecret`);
      return endpoint;
    },
    getEndpoint(id: string): FakeEndpoint {
      const found = endpoints.get(id);
      if (found === undefined) throw noSuch("webhook endpoint", id, "id");
      return found;
    },
    deleteEndpoint(id: string): void {
      if (!endpoints.delete(id)) throw noSuch("webhook endpoint", id, "id");
      secrets.delete(id);
    },

    reset(): void {
      for (const map of [
        customers,
        taxIds,
        sessions,
        paymentIntents,
        charges,
        invoices,
        refunds,
        disputes,
        endpoints,
        secrets,
        deliveries,
      ] as Array<Map<string, unknown>>)
        map.clear();
      deletedCustomers.clear();
      invoiceCustomerFilterIgnored = false;
      events.length = 0;
      ids.reset();
    },
  };
}

export type Store = ReturnType<typeof createStore>;
