// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isBillingOn } from "@/billing/enabled";
import { getWorkspaceBillingService } from "@/billing/shared";
import { loadWorkspaceBillingPage } from "@/billing/workspace-page-load";
import { getDatabase } from "@/db/startup";
import { BillingPageContent } from "@/workspace-billing/ui/billing-page";
import { requireWorkspace } from "@/workspaces/access-runtime";

export const metadata: Metadata = { title: "Settings · Billing" };

// The billing page of the workspace (ADR 0006, 2.5; #505): the balance, adding credit, the journal with the price of each review and
// the monthly limit. It exists only while billing is on and then takes the place of the plan and usage page; with billing off it is
// the 404 of a path that does not exist. An Owner or an Admin changes things, a Member reads. The workspace is the one in the
// address, for a member only. The payment page sends the buyer back here with `?topup=success` or `?topup=cancelled`.
export default async function BillingSettingsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/settings/billing">) {
  const { workspace: slug } = await params;
  const topup = (await searchParams).topup;
  const { workspace, role, user } = await requireWorkspace(slug);
  const db = getDatabase();
  const page = await loadWorkspaceBillingPage({
    isOn: () => isBillingOn(db),
    service: getWorkspaceBillingService(),
    actor: { workspaceId: workspace.id, userId: user.id, role },
    topup,
  });
  if (page.kind === "not_found") notFound();
  return (
    <BillingPageContent
      workspaceSlug={workspace.slug}
      view={page.view}
      returned={page.returned}
      // The operator's terms have no page of their own in the app yet: the confirmation states them in words (follow-up).
      termsHref={null}
    />
  );
}
