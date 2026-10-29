// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The billing page of the admin portal (#504, ADR 0006, 2.14): the switch with the statement of what it does, the payment
// adapter and the Stripe credentials, the rates and numbers, the links to the terms and the privacy statement, and the manual credit. Billing is off until the admin switches it
// on; opening this page changes nothing and calls nobody. Instance admin only.
import { useProductIdentity } from "@/product-identity/context";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { browserBillingApi, type BillingApi } from "./billing-api.ts";
import { BillingCreditCard } from "./billing-credit-card.tsx";
import { BillingJournalCheckCard } from "./billing-journal-check-card.tsx";
import { BillingLegalCard } from "./billing-legal-card.tsx";
import { BillingPaymentCard } from "./billing-payment-card.tsx";
import { BillingRatesCard } from "./billing-rates-card.tsx";
import { BillingSecretRemoval } from "./billing-secret-removal.tsx";
import { BillingSwitchCard } from "./billing-switch-card.tsx";
import type { BillingView } from "./billing-view.ts";

export function BillingPage({
  billing,
  notice,
  api = browserBillingApi,
}: {
  billing: BillingView;
  /** The paragraphs that say what switching billing on does (`enablingNotice`), made by the server. */
  notice: string[];
  /** Only tests pass this. */
  api?: BillingApi;
}) {
  const product = useProductIdentity();
  return (
    <div className="flex flex-col gap-6">
      <HelpDisclosure label="How this works">
        Billing is off until you switch it on here, and while it is off nothing
        of it runs: no page for workspaces, no route and no call to a payment
        provider. The Stripe API key and the webhook secret are stored encrypted
        on this server with the key of this server (APP_SECRET), so anyone who
        holds both can decrypt them. Only a {product.name} admin can see or
        change this page.
      </HelpDisclosure>
      <BillingSwitchCard billing={billing} notice={notice} api={api} />
      <BillingJournalCheckCard billing={billing} />
      <BillingPaymentCard billing={billing} api={api} />
      <BillingRatesCard billing={billing} api={api} />
      <BillingLegalCard billing={billing} api={api} />
      <BillingCreditCard api={api} />
      <BillingSecretRemoval billing={billing} api={api} />
    </div>
  );
}
