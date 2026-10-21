// SPDX-License-Identifier: Apache-2.0

// The `manual` adapter (ADR 0006, P10; #497): prepaid billing with no payment provider, for a self-hosting operator. It
// has no checkout (`{ kind: "none" }`: the workspace page says "ask your operator to add credit") and no webhook (the
// webhook route answers the missing path while it is the active adapter). Credit and corrections are written by the
// operator through `manual-credit.ts`, which is a service of the application, not of this adapter: an adapter never
// touches the journal.
import "server-only";
import {
  BILLING_CURRENCY,
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  type BillingAdapter,
} from "./adapter.ts";

export const MANUAL_ADAPTER_ID = "manual";

export const manualAdapter: BillingAdapter = {
  id: MANUAL_ADAPTER_ID,
  capabilities: {
    merchantOfRecord: false,
    customAmount: true,
    partialRefund: false,
    minTopUp: TOP_UP_MIN_MICRO_USD,
    maxTopUp: TOP_UP_MAX_MICRO_USD,
    currencies: [BILLING_CURRENCY],
    providerMayRefund: null,
    checkout: false,
    requiresBillingProfile: false,
    receiptsFrom: "app",
  },
  ensureCustomer: () => Promise.resolve(null),
  createTopUpCheckout: () =>
    Promise.resolve({
      checkout: { kind: "none" },
      session: null,
      payment: null,
    }),
};
