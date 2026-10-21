// SPDX-License-Identifier: Apache-2.0

// The calls the page of the billing review rows makes to its own data routes (src/billing/admin-http.ts, #603). Browser side;
// nothing throws, a failure is a stable code the page translates (billing-messages.ts). The list itself is read by the server
// page from the address (`?state=&page=`), so there is no call for it here.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { BillingReviewView } from "./billing-review-view.ts";

/** Which row: the provider and the event id the list showed. */
export type BillingReviewTarget = { provider: string; eventId: string };

export type BillingReviewResolveInput = BillingReviewTarget & {
  /** Required: why the row is closed. */
  note: string;
  /** Credits (or corrects) the workspace of the row by hand first; the server picks the workspace, once per row. */
  credit?: { type: "credit" | "correction"; amountMicroUsd: number };
};

export type BillingReviewApi = {
  resolve(
    input: BillingReviewResolveInput,
  ): Promise<RequestResult<{ ok: true; review: BillingReviewView }>>;
  /** Asks the payment provider about the top-up of the row; the answer is the state of the top-up. */
  check(
    input: BillingReviewTarget,
  ): Promise<
    RequestResult<{ ok: true; intentState: string; review: BillingReviewView }>
  >;
};

const BASE = "/api/admin/billing/reviews";

export function createBillingReviewApi(fetchImpl: FetchLike): BillingReviewApi {
  return {
    resolve: (input) =>
      requestJson(fetchImpl, "POST", `${BASE}/resolve`, input),
    check: (input) => requestJson(fetchImpl, "POST", `${BASE}/check`, input),
  };
}

export const browserBillingReviewApi = createBillingReviewApi((url, init) =>
  fetch(url, init),
);
