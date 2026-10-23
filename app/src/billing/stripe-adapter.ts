// SPDX-License-Identifier: Apache-2.0

// The Stripe adapter (ADR 0006, 2.12 and 2.13; #501): the interface of `adapter.ts` over the Stripe client of #500, for
// Stripe Managed Payments (Stripe is the seller of record and issues the buyer's invoice). It performs two actions at Stripe,
// reads what Stripe sends (`verifyAndParseWebhook`, #502) and can be asked what became of a top-up (`lookupTopUp`, #502):
//
//   - `ensureCustomer` makes the Stripe Customer from the workspace's billing profile, once, and brings it up to date at the
//     next call. Managed Payments allows neither `tax_id_collection` nor `customer_update[name|address]`, so the application
//     keeps the profile and pre-creates the Customer from it: `name` and `business_name`, `address`, `preferred_locales`,
//     the VAT ID as a `tax_id` (`eu_vat`, `gb_vat`, `ch_vat` or `no_vat`). The id is the only thing that is stored.
//   - `createTopUpCheckout` makes one Checkout Session, `mode=payment`, for a server-chosen amount: one line "Review credit"
//     with `price_data` (USD, the amount in cents, `tax_behavior: exclusive`, an eligible product tax code),
//     `managed_payments[enabled]=true`, the customer, our intent id as `client_reference_id` and in the metadata, and the
//     workspace's billing page as success and cancel address. The Idempotency-Key is derived from the intent, so the same
//     intent is the same session however often it is asked for (a lost answer, a repeated click, a retry after a crash).
//
// `STRIPE_CHECKOUT_PARAMETERS` is the whole set of parameters a session takes from us; none that Managed Payments refuses
// (`tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`, ...) is in it, and the
// client's input type has no field for them. Everything Stripe answers is data: an error becomes a stable code of the
// adapter (`BillingAdapterError`) without a word of what Stripe said, and the profile, an amount or the address of a session
// is never logged here (the adapter logs nothing).
//
// The webhook is verified with the secret the instance admin stored (`webhookSecret`, read when a request arrives) over the exact
// bytes of the body, and only then read (`stripe-webhook-parse.ts`); an event of the other environment than the stored key's is
// refused. It makes no outbound call and touches no database. "Check payment" (`lookupTopUp`) is the one call at Stripe that
// serves a webhook's purpose, made in a user's request: it asks for the Checkout Session and answers the same normalized event
// the webhook would have, so a lost webhook, a late one and a click are idempotent together.
import "server-only";
import { createHash } from "node:crypto";
import {
  BILLING_CURRENCY,
  BillingAdapterError,
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  assertTopUpAmount,
  isProviderCurrency,
  toProviderAmount,
  type BillingAdapter,
  type BillingCapabilities,
  type BillingProfile,
  type BillingWebhookRejectionCode,
  type InvoiceSummary,
  type ProviderRef,
  type TopUpLookupEvent,
} from "./adapter.ts";
import { STRIPE_ADAPTER_ID } from "./readiness.ts";
import {
  StripeClientError,
  type StripeClient,
  type StripeEnvironment,
} from "./stripe-client.ts";
import {
  paymentEventOfSession,
  parseStripeWebhookEvent,
} from "./stripe-webhook-parse.ts";
import {
  verifyStripeSignature,
  type StripeSignatureErrorCode,
} from "./stripe-webhook-verify.ts";

export { STRIPE_ADAPTER_ID };

/**
 * The product tax code of the credit line (ADR 0006, 2.13): Managed Payments needs an eligible one. The sandbox takes the
 * digital-goods family (`txcd_10...`: this one and `txcd_10103001` were both accepted on 2026-10-21) and refuses the rest;
 * which code is right for prepaid credit is a tax question of #503, not of this code.
 */
export const STRIPE_TOP_UP_TAX_CODE = "txcd_10105002";
export const STRIPE_TOP_UP_PRODUCT_NAME = "Review credit";

/** Every parameter a Checkout Session takes from this adapter. Pinned by a test; no unsupported one can be added unseen. */
export const STRIPE_CHECKOUT_PARAMETERS = [
  "mode",
  "line_items",
  "success_url",
  "cancel_url",
  "customer",
  "client_reference_id",
  "metadata",
  "managed_payments",
] as const;

const MICRO_USD_PER_CENT = 10_000;

/** The Idempotency-Key of the session of a top-up: the intent decides it, nothing else. */
export function topUpCheckoutKey(intentId: string): string {
  return `topup-checkout:${intentId}`;
}

/**
 * The Idempotency-Key of the creation of a customer: the workspace and the exact content it is created with. The same
 * profile asked for twice (two clicks at once, a retry after a lost answer) is one customer; a profile that changed in the
 * meantime is another request, not a conflict with the first. A customer made to replace one Stripe no longer knows names
 * it (`replaces`), because Stripe would answer the same key with the customer that is gone. Stripe forgets a key after 24
 * hours; the stored customer id is what makes it once for good.
 */
function customerKey(
  workspaceId: string,
  content: unknown,
  replaces: ProviderRef | null,
): string {
  const digest = createHash("sha256")
    .update(
      `${workspaceId}\n${replaces ?? ""}\n${JSON.stringify(content)}`,
      "utf8",
    )
    .digest("hex");
  return `customer:${digest}`;
}

/** A tax id without the spaces, dots and dashes Stripe adds when it shows one (`CHE-123.456.789 MWST`). */
const compact = (value: string) => value.replace(/[\s.-]/g, "");

/** The type of Stripe's tax id for a country, and the value in the form Stripe takes (`no_vat` has no country prefix). */
function taxIdOf(
  country: string,
  vatId: string,
): { type: string; value: string } {
  switch (country) {
    case "GB":
      return { type: "gb_vat", value: vatId };
    case "CH":
      return { type: "ch_vat", value: vatId };
    case "NO":
      return { type: "no_vat", value: vatId.replace(/^NO/, "") };
    default:
      return { type: "eu_vat", value: vatId };
  }
}

function adapterErrorOf(error: StripeClientError): BillingAdapterError {
  switch (error.code) {
    case "timeout":
    case "network_error":
    case "rate_limited":
    case "server_error":
      return new BillingAdapterError(
        "provider_unavailable",
        "the payment provider is not available right now",
      );
    case "conflict":
      // Stripe answers 409 while another request with the same Idempotency-Key is still running.
      return new BillingAdapterError(
        "request_in_progress",
        "the payment provider is still working on the same request",
      );
    case "unauthorized":
    case "forbidden":
    case "invalid_configuration":
    case "environment_mismatch":
      return new BillingAdapterError(
        "provider_not_configured",
        "the payment provider does not accept the configured credentials",
      );
    default:
      return new BillingAdapterError(
        "provider_rejected",
        "the payment provider refused the request",
      );
  }
}

/** Runs one call at Stripe; what it throws becomes a code of the adapter, and nothing else is caught. */
async function atStripe<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StripeClientError) throw adapterErrorOf(error);
    throw error;
  }
}

export type StripeAdapterDependencies = {
  /**
   * The client for the stored credentials, made when it is needed (never at startup, never while billing is off). It
   * rejects when there is no usable key; the adapter answers `provider_not_configured`.
   */
  client: () => Promise<StripeClient>;
  /**
   * The signing secret of the webhook endpoint (`whsec_...`) the instance admin stored, or null when there is none. Read when a
   * webhook arrives; without it, or without `environment`, every webhook is refused (`signature_invalid`).
   */
  webhookSecret?: () => Promise<string | null>;
  /** The environment of the stored API key (`test` or `live`), or null when it cannot be told. */
  environment?: () => Promise<StripeEnvironment | null>;
  /** The clock of the events a lookup makes. Default: the real one. */
  now?: () => Date;
};

const SIGNATURE_REJECTION: Record<
  StripeSignatureErrorCode,
  BillingWebhookRejectionCode
> = {
  secret_missing: "signature_invalid",
  signature_missing: "signature_missing",
  signature_malformed: "signature_invalid",
  signature_mismatch: "signature_invalid",
  timestamp_out_of_tolerance: "signature_expired",
  tolerance_invalid: "signature_invalid",
};

export function createStripeAdapter({
  client: makeClient,
  webhookSecret,
  environment,
  now = () => new Date(),
}: StripeAdapterDependencies): BillingAdapter {
  async function clientOf(): Promise<StripeClient> {
    try {
      return await makeClient();
    } catch {
      throw new BillingAdapterError(
        "provider_not_configured",
        "the payment provider is not set up",
      );
    }
  }

  function customerFields(
    workspaceId: string,
    profile: BillingProfile,
  ): {
    name: string;
    business_name: string;
    address: {
      line1: string;
      line2?: string;
      city: string;
      postal_code: string;
      country: string;
    };
    preferred_locales: string[];
    metadata: Record<string, string>;
  } {
    const [line1 = "", line2] = profile.addressLines;
    return {
      name: profile.legalName,
      business_name: profile.legalName,
      address: {
        line1,
        ...(line2 === undefined ? {} : { line2 }),
        city: profile.city,
        postal_code: profile.postalCode,
        country: profile.country,
      },
      preferred_locales: [profile.locale],
      metadata: { workspace: workspaceId },
    };
  }

  /** The VAT ID of the profile is the customer's one tax id: others are removed, a missing one is added. */
  async function syncTaxId(
    client: StripeClient,
    customerId: string,
    profile: BillingProfile,
  ): Promise<void> {
    const wanted =
      profile.vatId === null ? null : taxIdOf(profile.country, profile.vatId);
    // Always read: a customer that was made by an earlier attempt of this same call may carry a tax id already.
    const customer = await atStripe(() =>
      client.getCustomer(customerId, { expandTaxIds: true }),
    );
    const present = customer.tax_ids?.data ?? [];
    const same = (item: { type: string; value: string }) =>
      wanted !== null &&
      item.type === wanted.type &&
      compact(item.value) === compact(wanted.value);
    for (const existing of present)
      if (!same(existing))
        await atStripe(() =>
          client.deleteCustomerTaxId(customerId, existing.id),
        );
    if (wanted === null || present.some(same)) return;
    try {
      await client.createCustomerTaxId(customerId, wanted);
    } catch (error) {
      // Stripe checks the shape of the number for its type: a refusal of this call is about the VAT ID and nothing else.
      if (error instanceof StripeClientError && error.code === "bad_request")
        throw new BillingAdapterError(
          "vat_id_rejected",
          "the payment provider did not accept the VAT ID",
        );
      if (error instanceof StripeClientError) throw adapterErrorOf(error);
      throw error;
    }
  }

  const capabilities: BillingCapabilities = {
    merchantOfRecord: true,
    customAmount: true,
    // To be confirmed in the sandbox plan of #503.
    partialRefund: true,
    minTopUp: TOP_UP_MIN_MICRO_USD,
    maxTopUp: TOP_UP_MAX_MICRO_USD,
    currencies: [BILLING_CURRENCY],
    // Stripe may refund, and concede a dispute, within 60 days whatever our terms say.
    providerMayRefund: { windowDays: 60 },
    checkout: true,
    requiresBillingProfile: true,
    receiptsFrom: "provider",
  };

  return {
    id: STRIPE_ADAPTER_ID,
    capabilities,

    async ensureCustomer({ workspace, profile, customer }) {
      const client = await clientOf();
      const fields = customerFields(workspace.id, profile);
      let id: ProviderRef | null = customer;
      if (id !== null) {
        try {
          await client.updateCustomer(id, fields);
        } catch (error) {
          // A customer Stripe does not know (deleted on the buyer's request, or made in the other environment) is made again.
          if (!(error instanceof StripeClientError)) throw error;
          if (error.code !== "not_found") throw adapterErrorOf(error);
          id = null;
        }
      }
      if (id === null) {
        const created = await atStripe(() =>
          client.createCustomer(fields, {
            idempotencyKey: customerKey(workspace.id, fields, customer),
          }),
        );
        id = created.id;
      }
      await syncTaxId(client, id, profile);
      return id;
    },

    async resumeTopUpCheckout({ checkout }) {
      const client = await clientOf();
      let session;
      try {
        session = await client.getCheckoutSession(checkout);
      } catch (error) {
        // A session Stripe does not know (the other environment, or gone) is a page nobody can use.
        if (error instanceof StripeClientError && error.code === "not_found")
          return { kind: "closed" };
        if (error instanceof StripeClientError) throw adapterErrorOf(error);
        throw error;
      }
      if (session.status !== "open" || session.url === null)
        return { kind: "closed" };
      return { kind: "open", url: session.url };
    },

    async verifyAndParseWebhook({ headers, rawBody, now: at }) {
      // The secret and the environment are read now, not at startup: the admin may store or replace them at any time.
      let secret: string | null = null;
      let stored: StripeEnvironment | null = null;
      try {
        secret = (await webhookSecret?.()) ?? null;
        stored = (await environment?.()) ?? null;
      } catch {
        // Unreadable is the same as absent: nothing is trusted that cannot be checked.
      }
      if (secret === null || stored === null)
        return { ok: false, code: "signature_invalid" };
      const verdict = verifyStripeSignature({
        header: headers.get("stripe-signature"),
        rawBody,
        secret,
        now: at,
      });
      if (!verdict.ok)
        return { ok: false, code: SIGNATURE_REJECTION[verdict.code] };
      // The signature covers these exact bytes; only now are they decoded (strictly: a byte that is not UTF-8 is no event).
      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            rawBody,
          ),
        );
      } catch {
        return { ok: false, code: "body_invalid" };
      }
      const parsed = parseStripeWebhookEvent(body, { environment: stored });
      return parsed.ok
        ? { ok: true, event: parsed.event }
        : { ok: false, code: "body_invalid" };
    },

    async lookupTopUp({
      intentId,
      checkout,
    }): Promise<TopUpLookupEvent | null> {
      // Only the session of the top-up is asked for: a payment intent alone has no net amount to credit.
      if (checkout === null) return null;
      const stored = (await environment?.()) ?? null;
      if (stored === null)
        throw new BillingAdapterError(
          "provider_not_configured",
          "the payment provider is not set up",
        );
      const client = await clientOf();
      let session;
      try {
        session = await client.getCheckoutSession(checkout);
      } catch (error) {
        // A session Stripe does not know (gone with the buyer's data, or of the other environment) is nothing to report.
        if (error instanceof StripeClientError && error.code === "not_found")
          return null;
        if (error instanceof StripeClientError) throw adapterErrorOf(error);
        throw error;
      }
      const at = now().toISOString();
      const meta = (kind: string) => ({
        eventId: `check-${session.id}-${kind}`,
        occurredAt: at,
      });
      let event;
      if (session.mode !== "payment") return null;
      if (session.status === "expired")
        event = paymentEventOfSession(
          session,
          meta("expired"),
          stored,
          "expired",
        );
      else if (
        session.status === "complete" &&
        session.payment_status === "paid"
      )
        event = paymentEventOfSession(session, meta("paid"), stored, "paid");
      else if (
        session.status === "complete" &&
        session.payment_intent !== null &&
        (await paymentFailed(client, session.payment_intent))
      )
        event = paymentEventOfSession(
          session,
          meta("failed"),
          stored,
          "failed",
        );
      else return null;
      // Our own intent: the one the app asked about, whatever the session says. A session that names another is not it.
      if (event.type === "ignored") return null;
      if (
        event.type !== "payment.refused" &&
        event.intentId !== null &&
        event.intentId !== intentId
      )
        return null;
      return event;
    },

    async listInvoices({ customer }) {
      const client = await clientOf();
      const found = await atStripe(() => client.listInvoices(customer));
      const invoices: InvoiceSummary[] = [];
      for (const invoice of found) {
        // Stripe is asked for one customer; an answer for another one is never shown (a mistake of ours or Stripe's).
        if (invoice.customer !== customer) continue;
        const status = invoice.status;
        if (
          status !== "paid" &&
          status !== "open" &&
          status !== "void" &&
          status !== "uncollectible"
        )
          continue;
        if (!isProviderCurrency(invoice.currency)) continue;
        if (!Number.isSafeInteger(invoice.total) || invoice.total <= 0)
          continue;
        invoices.push({
          id: invoice.id,
          number: invoice.number ?? null,
          createdAt: new Date(invoice.created * 1000).toISOString(),
          amount: toProviderAmount(invoice.total),
          currency: invoice.currency,
          status,
          viewUrl: webAddressOf(invoice.hosted_invoice_url),
          downloadUrl: webAddressOf(invoice.invoice_pdf),
        });
      }
      return invoices;
    },

    async createTopUpCheckout({ customer, intentId, amount, returnUrl }) {
      assertTopUpAmount(capabilities, amount);
      if (amount % MICRO_USD_PER_CENT !== 0)
        throw new BillingAdapterError(
          "amount_out_of_range",
          "the top-up amount is not a whole number of cents",
        );
      if (customer === null)
        throw new BillingAdapterError(
          "customer_missing",
          "a top-up at Stripe needs the buyer's customer",
        );
      const client = await clientOf();
      const back = (result: "success" | "cancelled") => {
        const url = new URL(returnUrl);
        url.searchParams.set("topup", result);
        return url.toString();
      };
      const session = await atStripe(() =>
        client.createCheckoutSession(
          {
            mode: "payment",
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: BILLING_CURRENCY,
                  unit_amount: amount / MICRO_USD_PER_CENT,
                  tax_behavior: "exclusive",
                  product_data: {
                    name: STRIPE_TOP_UP_PRODUCT_NAME,
                    tax_code: STRIPE_TOP_UP_TAX_CODE,
                  },
                },
              },
            ],
            success_url: back("success"),
            cancel_url: back("cancelled"),
            customer,
            client_reference_id: intentId,
            metadata: { intent: intentId },
            managed_payments: { enabled: true },
          },
          { idempotencyKey: topUpCheckoutKey(intentId) },
        ),
      );
      // A session that is not open has no page to send the buyer to.
      if (session.url === null)
        throw new BillingAdapterError(
          "provider_rejected",
          "the payment provider made a checkout with no page",
        );
      return {
        checkout: { kind: "redirect", url: session.url },
        session: session.id,
        payment: null,
      };
    },
  };
}

/** An address Stripe sent, when it is a plain http(s) address (never `javascript:` or the like); else null. */
function webAddressOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** A delayed payment that Stripe gave up on leaves its payment intent without a payment method (or canceled). */
async function paymentFailed(
  client: StripeClient,
  paymentIntent: string,
): Promise<boolean> {
  try {
    const intent = await client.getPaymentIntent(paymentIntent);
    return (
      intent.status === "requires_payment_method" ||
      intent.status === "canceled"
    );
  } catch (error) {
    // A payment intent that is gone, or that Stripe will not show, is not a failure we can state.
    if (error instanceof StripeClientError && error.code === "not_found")
      return false;
    if (error instanceof StripeClientError) throw adapterErrorOf(error);
    throw error;
  }
}
