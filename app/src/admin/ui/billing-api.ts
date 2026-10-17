// SPDX-License-Identifier: Apache-2.0

// The calls the billing page makes to its own data routes (src/billing/admin-http.ts). Browser side; nothing throws,
// a failure is a stable code the page translates (billing-messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { BillingEnvironment, BillingView } from "./billing-view.ts";

/** What the form sends. An empty or missing secret keeps the stored one. */
export type BillingSettingsChange = {
  environment: BillingEnvironment;
  clientToken: string;
  graceDays: number;
  apiKey?: string;
  webhookSecret?: string;
};

export type BillingChange =
  | { settings: BillingSettingsChange }
  | { removeSecret: "apiKey" | "webhookSecret" }
  | { enabled: boolean };

/** The result of the connection check: it worked, or a stable code. */
export type BillingCheckAnswer = { ok: true } | { ok: false; error: string };

export type BillingApi = {
  change(
    change: BillingChange,
  ): Promise<RequestResult<{ ok: true; billing: BillingView }>>;
  /** A harmless call to Paddle with the stored API key. */
  check(): Promise<RequestResult<BillingCheckAnswer>>;
  /** Creates the notification destination at Paddle and stores the secret it returns. */
  createDestination(): Promise<
    RequestResult<{ ok: true; billing: BillingView }>
  >;
};

export function createBillingApi(fetchImpl: FetchLike): BillingApi {
  return {
    change: (change) =>
      requestJson(fetchImpl, "PUT", "/api/admin/billing", change),
    check: () => requestJson(fetchImpl, "POST", "/api/admin/billing/check", {}),
    createDestination: () =>
      requestJson(
        fetchImpl,
        "POST",
        "/api/admin/billing/notification-destination",
        {},
      ),
  };
}

export const browserBillingApi = createBillingApi((url, init) =>
  fetch(url, init),
);
