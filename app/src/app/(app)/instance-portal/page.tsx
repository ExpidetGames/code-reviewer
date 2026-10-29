// SPDX-License-Identifier: LicenseRef-Proprietary

// The overview of the admin portal. Only the instance admin sees it: anybody else gets a 404 as if the
// page did not exist (src/admin/access.ts).
import { getProductIdentity } from "@/product-identity/current";
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { countOpenBillingReviews } from "@/billing/shared";
import { getIntegrationsPageData } from "@/github-config/shared";
import { Overview } from "@/admin/ui/overview";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  await requireAdmin();
  const [settings, github, billingReviewCount] = await Promise.all([
    getAdminService().readSettings(),
    getIntegrationsPageData(),
    countOpenBillingReviews(),
  ]);
  return (
    <>
      <PageHeader title="Admin" />
      <Overview
        product={getProductIdentity()}
        settings={settings}
        github={github.view}
        emailConflictCount={github.conflicts.length}
        billingReviewCount={billingReviewCount}
      />
    </>
  );
}
