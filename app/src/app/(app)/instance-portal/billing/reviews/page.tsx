// SPDX-License-Identifier: Apache-2.0

// Payment reviews: the billing events that moved money (or claimed to) and changed nothing in the ledger, open or resolved,
// newest first, with the repairs next to each (#603, ADR 0006). Instance admin only. The state and the page are in the address
// (`?state=open|resolved&page=`); an address that is not one of those shows the first page of the open rows.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { BillingReviewsPage } from "@/admin/ui/billing-reviews-page";
import { getBillingReviewService } from "@/billing/shared";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Payment reviews · Admin" };

function pageOf(value: string | string[] | undefined): number {
  const text = typeof value === "string" ? value : "";
  return /^[1-9][0-9]{0,5}$/.test(text) ? Number(text) : 1;
}

export default async function AdminBillingReviewsPage(
  props: PageProps<"/instance-portal/billing/reviews">,
) {
  await requireAdmin();
  const query = await props.searchParams;
  const list = await getBillingReviewService().list({
    state: query.state === "resolved" ? "resolved" : "open",
    page: pageOf(query.page),
  });
  return (
    <>
      <PageHeader
        title="Payment reviews"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Billing", href: "/admin/billing" },
              { label: "Payment reviews" },
            ]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        <BillingReviewsPage list={list} />
      </div>
    </>
  );
}
