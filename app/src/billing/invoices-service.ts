// SPDX-License-Identifier: Apache-2.0

// The invoices of a workspace (#659): what the payment provider issued for the top-ups of THIS workspace, for the billing page.
// The invoices stay at the provider; the app keeps no copy and no reference, it asks when the page asks. The order, each step
// ends the request on failure:
//
//   1. role       an Owner or an Admin (`manage_billing`), like the rest of the money pages          forbidden
//   2. adapter    the active adapter can list invoices (`listInvoices`): else there are none to list  an empty list
//   3. customer   the provider's customer the app stored for THIS workspace's billing profile, made at this adapter:
//                 a workspace that never topped up has none, and the list is empty without a call
//   4. ask        the adapter lists the invoices of that one customer; nothing else is ever passed to the provider.
//                 A provider that has no such customer (stored under a key of the other environment) is an empty list,
//                 logged as `customer_missing`; any other failure ends the request
//
// The workspace is the actor's, from the access check of the request; no id of the request body or address names a customer, so
// another workspace's invoices cannot be asked for. A provider that fails is a stable code, never a word of what it said. The log
// gets the workspace id and a result code, never an amount, an id of the provider or a person.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import type { Database } from "../db/schema.ts";
import type { InvoiceListView } from "../workspace-billing/view.ts";
import { can } from "../workspaces/permissions.ts";
import { BillingAdapterError, type BillingAdapter } from "./adapter.ts";
import type { BillingActor } from "./profile-service.ts";

export const INVOICES_ERROR_CODES = [
  "forbidden",
  "provider_unavailable",
  "provider_rejected",
  "provider_not_configured",
] as const;
export type InvoicesErrorCode = (typeof INVOICES_ERROR_CODES)[number];

export type InvoicesResult =
  { ok: true; list: InvoiceListView } | { ok: false; error: InvoicesErrorCode };

export type InvoicesService = {
  list(actor: BillingActor): Promise<InvoicesResult>;
};

const ADAPTER_ERROR_TO_CODE: Partial<
  Record<BillingAdapterError["code"], InvoicesErrorCode>
> = {
  provider_unavailable: "provider_unavailable",
  request_in_progress: "provider_unavailable",
  provider_not_configured: "provider_not_configured",
};

export function createInvoicesService({
  db,
  activeAdapter,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  /** The adapter billing runs on, or undefined when the setting names one this instance does not have. */
  activeAdapter: () => Promise<BillingAdapter | undefined>;
  log?: (line: string) => void;
}): InvoicesService {
  return {
    async list(actor) {
      const done = (result: InvoicesResult, code?: string): InvoicesResult => {
        log(
          `[billing] INVOICES_LISTED workspace=${actor.workspaceId} result=${code ?? (result.ok ? "ok" : result.error)}`,
        );
        return result;
      };
      if (!can(actor.role, "manage_billing"))
        return done({ ok: false, error: "forbidden" });

      const empty: InvoicesResult = { ok: true, list: { invoices: [] } };
      const adapter = await activeAdapter();
      if (adapter?.listInvoices === undefined) return done(empty);

      const profile = await createBillingProfilesRepository(
        db,
        actor.workspaceId,
      ).get();
      // A customer made at another adapter is not one of this provider's.
      if (
        profile === undefined ||
        profile.customerRef === null ||
        profile.customerAdapter !== adapter.id
      )
        return done(empty);

      try {
        const found = await adapter.listInvoices({
          customer: profile.customerRef,
        });
        return done({
          ok: true,
          list: {
            invoices: found.map((invoice) => ({
              id: invoice.id,
              number: invoice.number,
              createdAt: invoice.createdAt,
              amountMinor: invoice.amount,
              currency: invoice.currency,
              status: invoice.status,
              viewUrl: invoice.viewUrl,
              downloadUrl: invoice.downloadUrl,
            })),
          },
        });
      } catch (error) {
        // The provider does not know the stored customer (a key of the other environment): nothing to list, and a retry would
        // fail the same way, so the card shows the empty list instead of an error. The log line carries the code.
        if (
          error instanceof BillingAdapterError &&
          error.code === "customer_missing"
        )
          return done(empty, "customer_missing");
        if (error instanceof BillingAdapterError)
          return done({
            ok: false,
            error: ADAPTER_ERROR_TO_CODE[error.code] ?? "provider_rejected",
          });
        log(
          `[billing] INVOICES_LISTED workspace=${actor.workspaceId} result=unexpected_error`,
        );
        throw error;
      }
    },
  };
}
