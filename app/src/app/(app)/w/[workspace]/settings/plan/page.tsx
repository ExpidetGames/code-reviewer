// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { billingPageLinkedFor } from "@/billing/shared";
import { getPlanManagementUrl } from "@/plan-handoff/shared";
import { planViewFor } from "@/usage/shared";
import { PlanPageContent } from "@/usage/ui/plan-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspacePath } from "@/workspaces/paths";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Settings · Plan and usage" };

// The plan and usage page of the workspace (#282): what it may use in the current period and what it has used,
// read-only for every member. It exists for every workspace; the settings navigation links to it only while the
// workspace has entitlements, and for one without, the page says that no limits apply. This is where the operator's
// page and the refusal notice lead to (src/plan-handoff/return-path.ts). While billing is on it leads on to the Billing page
// (#505). The workspace is the one in the address, for a member only.
export default async function PlanSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/plan">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  // While billing is on, the Billing page takes the place of this one (#505); with billing off nothing changes.
  if (await billingPageLinkedFor())
    redirect(workspacePath(workspace.slug, "/settings/billing"));
  const canManagePlan = can(role, "manage_plan");
  const [plan, planManagementUrl] = await Promise.all([
    planViewFor(workspace.id),
    // Only asked for somebody the role lets through: a Member's page never reads the setting.
    canManagePlan ? getPlanManagementUrl() : Promise.resolve(null),
  ]);
  return (
    <PlanPageContent
      workspaceSlug={workspace.slug}
      plan={plan}
      // An unlimited workspace has no entry of its own in the navigation; the page is only reached by address.
      showPlanLink={plan.kind !== "unlimited"}
      canManagePlan={canManagePlan && planManagementUrl !== null}
    />
  );
}
