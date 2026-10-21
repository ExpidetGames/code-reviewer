// SPDX-License-Identifier: Apache-2.0

// The Stripe adapter (ADR 0006, 2.12 and 2.13; #501): the interface of `adapter.ts` over the Stripe client of #500, for
// Stripe Managed Payments (Stripe is the seller of record and issues the buyer's invoice). It performs two actions at Stripe
// and reads nothing from a webhook yet (`verifyAndParseWebhook` and the lookup are wired in #502):
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
import "server-only";
import { createHash } from "node:crypto";
import {
  BILLING_CURRENCY,
  BillingAdapterError,
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  assertTopUpAmount,
  type BillingAdapter,
  type BillingCapabilities,
  type BillingProfile,
  type ProviderRef,
} from "./adapter.ts";
import { STRIPE_ADAPTER_ID } from "./readiness.ts";
import { StripeClientError, type StripeClient } from "./stripe-client.ts";

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
};

export function createStripeAdapter({
  client: makeClient,
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
