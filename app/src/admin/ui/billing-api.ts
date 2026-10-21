// SPDX-License-Identifier: Apache-2.0

// The calls the billing page makes to its own data routes (src/billing/admin-http.ts). Browser side; nothing throws, a failure
// is a stable code the page translates (billing-messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type {
  BillingAdapterChoice,
  BillingView,
  BillingWorkspaceBalanceView,
  BillingWorkspaceView,
} from "./billing-view.ts";

/** The rates and numbers the form sends, as the whole numbers they are stored as. A field left out stays as it is. */
export type BillingRatesChange = {
  factorA?: number;
  minuteRateMicroUsd?: { diff?: number; dynamic?: number };
  diffAiReserveMicroUsd?: number;
  startCreditMicroUsd?: number;
  lowBalanceMicroUsd?: number;
  hourlyReviewLimit?: number;
};

export type BillingChange =
  | { adapter: BillingAdapterChoice }
  /** An empty or missing secret keeps the stored one. */
  | { stripe: { apiKey?: string; webhookSecret?: string } }
  | { removeSecret: "apiKey" | "webhookSecret" }
  | { rates: BillingRatesChange }
  | { enabled: boolean };

/** The result of the connection check: it worked (and for which environment), or a stable code. */
export type BillingCheckAnswer =
  { ok: true; environment: "test" | "live" } | { ok: false; error: string };

export type BillingCreditInput = {
  type: "credit" | "correction";
  amountMicroUsd: number;
  note: string;
  /** Makes one entry however often the form is sent. */
  requestId: string;
};

export type BillingApi = {
  change(
    change: BillingChange,
  ): Promise<RequestResult<{ ok: true; billing: BillingView }>>;
  /** A harmless call to Stripe with the stored API key. */
  check(): Promise<RequestResult<BillingCheckAnswer>>;
  /**
   * Creates the webhook endpoint at Stripe and stores the secret it returns (or adopts the one that exists). `recreate`
   * replaces the endpoint and the secret instead.
   */
  createWebhookEndpoint(options?: {
    recreate?: boolean;
  }): Promise<
    RequestResult<{ ok: true; created: boolean; billing: BillingView }>
  >;
  searchWorkspaces(
    text: string,
  ): Promise<RequestResult<{ workspaces: BillingWorkspaceView[] }>>;
  workspace(id: string): Promise<RequestResult<BillingWorkspaceBalanceView>>;
  credit(
    workspaceId: string,
    input: BillingCreditInput,
  ): Promise<
    RequestResult<{ ok: true; workspace: BillingWorkspaceBalanceView }>
  >;
};

const BASE = "/api/admin/billing";

export function createBillingApi(fetchImpl: FetchLike): BillingApi {
  return {
    change: (change) => requestJson(fetchImpl, "PUT", BASE, change),
    check: () => requestJson(fetchImpl, "POST", `${BASE}/check`, {}),
    createWebhookEndpoint: (options = {}) =>
      requestJson(
        fetchImpl,
        "POST",
        `${BASE}/webhook-endpoint`,
        options.recreate === true ? { recreate: true } : {},
      ),
    searchWorkspaces: (text) =>
      requestJson(
        fetchImpl,
        "GET",
        `${BASE}/workspaces?q=${encodeURIComponent(text)}`,
      ),
    workspace: (id) =>
      requestJson(
        fetchImpl,
        "GET",
        `${BASE}/workspaces/${encodeURIComponent(id)}`,
      ),
    credit: (workspaceId, input) =>
      requestJson(
        fetchImpl,
        "POST",
        `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/credit`,
        input,
      ),
  };
}

export const browserBillingApi = createBillingApi((url, init) =>
  fetch(url, init),
);
