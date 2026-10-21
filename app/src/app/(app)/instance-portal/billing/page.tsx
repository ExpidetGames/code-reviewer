// SPDX-License-Identifier: Apache-2.0

// Billing: the switch, the payment adapter and the Stripe credentials, the rates and numbers, and the manual credit (#504,
// ADR 0006). Instance admin only. Opening this page changes nothing and calls nobody; billing stays off until the admin
// switches it on.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { BillingPage } from "@/admin/ui/billing-page";
import { enablingNotice } from "@/billing/enabling-copy";
import { getBillingAdminService } from "@/billing/shared";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Billing · Admin" };

export default async function AdminBillingPage() {
  await requireAdmin();
  const billing = await getBillingAdminService().view();
  return (
    <>
      <PageHeader
        title="Billing"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "Billing" }]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        {/* Not keyed on the data: the forms keep their sentences while the page's data is refreshed. */}
        <BillingPage
          billing={billing}
          notice={enablingNotice({
            workspaces: billing.workspaces,
            ownKeyWorkspaces: billing.ownKeyWorkspaces,
          })}
        />
      </div>
    </>
  );
}
