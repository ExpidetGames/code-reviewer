// SPDX-License-Identifier: Apache-2.0

// The calls the billing page of a workspace makes to its own routes (#505). Browser side; nothing throws: a failure is a stable
// code the page translates (`messages.ts`). The workspace is the one in the address of every call, never in a body.
import { workspaceApiPath } from "../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../ui/json-request.ts";
import type {
  BillingProfileFormView,
  InvoiceListView,
  JournalPageView,
} from "./view.ts";

/** What the profile form sends: the content only. The business confirmation goes with the first top-up. */
export type BillingProfileInput = Omit<
  BillingProfileFormView,
  "businessConfirmed"
>;

export type WorkspaceBillingApi = {
  saveProfile(
    input: BillingProfileInput,
  ): Promise<RequestResult<{ profile: BillingProfileFormView }>>;
  /** Starts a payment; the answer holds the address of the payment page to send the person to. */
  startTopUp(input: {
    amountCents: number;
    confirmBusiness: boolean;
    intentId: string;
  }): Promise<RequestResult<{ intentId: string; url: string }>>;
  checkPayment(
    intentId: string,
  ): Promise<RequestResult<{ intentId: string; state: string }>>;
  /** Whole US cents, or null to remove the limit. */
  setMonthlyLimit(
    cents: number | null,
  ): Promise<RequestResult<{ monthlyLimitCents: number | null }>>;
  journal(cursor: string): Promise<RequestResult<JournalPageView>>;
  /** The invoices of the workspace's own payments (Owner and Admin). */
  invoices(): Promise<RequestResult<InvoiceListView>>;
};

export function createWorkspaceBillingApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): WorkspaceBillingApi {
  const base = workspaceApiPath(workspaceSlug, "/billing");
  return {
    saveProfile: (input) =>
      requestJson(fetchImpl, "PUT", `${base}/profile`, input),
    startTopUp: (input) =>
      requestJson(fetchImpl, "POST", `${base}/top-ups`, input),
    checkPayment: (intentId) =>
      requestJson(
        fetchImpl,
        "POST",
        `${base}/top-ups/${encodeURIComponent(intentId)}/check`,
      ),
    setMonthlyLimit: (cents) =>
      requestJson(fetchImpl, "PUT", `${base}/monthly-limit`, {
        monthlyLimitCents: cents,
      }),
    invoices: () => requestJson(fetchImpl, "GET", `${base}/invoices`),
    journal: (cursor) =>
      requestJson(
        fetchImpl,
        "GET",
        `${base}/journal?cursor=${encodeURIComponent(cursor)}`,
      ),
  };
}

export function browserWorkspaceBillingApi(
  workspaceSlug: string,
): WorkspaceBillingApi {
  return createWorkspaceBillingApi(
    (url, init) => fetch(url, init),
    workspaceSlug,
  );
}
