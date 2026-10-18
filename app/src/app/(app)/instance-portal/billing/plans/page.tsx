// SPDX-License-Identifier: Apache-2.0

// Plans: what the operator sells, their versions and the Free plan (#438, ADR 0005). Instance admin only. While billing is
// off the page reads nothing and says so; opening it never changes anything.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { isBillingOnNow, getBillingPlansService } from "@/billing/shared";
import { PlansForm } from "@/admin/ui/plans-form";

export const metadata: Metadata = { title: "Plans · Admin" };

export default async function AdminPlansPage() {
  await requireAdmin();
  const billingOn = await isBillingOnNow();
  // Billing off: nothing of the plans is read.
  const plans = billingOn ? await getBillingPlansService().view() : null;
  return (
    <>
      <PageHeader
        title="Plans"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Billing", href: "/admin/billing" },
              { label: "Plans" },
            ]}
          />
        }
      />
      <div className="flex max-w-[56rem] flex-col gap-6 pt-6">
        <PlansForm billingOn={billingOn} initial={plans} />
      </div>
    </>
  );
}
