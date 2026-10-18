// SPDX-License-Identifier: Apache-2.0

// Billing: the Paddle credentials, the notification destination and the switch (#437, ADR 0005). Instance admin only.
// Opening this page changes nothing and calls nobody; billing stays off until the admin switches it on.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { BillingForm } from "@/admin/ui/billing-form";
import { enablingNotice } from "@/billing/enabling-copy";
import { getBillingSettingsService } from "@/billing/shared";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Billing · Admin" };

export default async function AdminBillingPage() {
  await requireAdmin();
  const billing = await getBillingSettingsService().view();
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
        {/* Not keyed on the data: the form keeps its sentences while the page's data is refreshed. */}
        <BillingForm
          billing={billing}
          notice={enablingNotice({
            ownKeyWorkspaces: billing.ownKeyWorkspaces,
          })}
        />
      </div>
    </>
  );
}
