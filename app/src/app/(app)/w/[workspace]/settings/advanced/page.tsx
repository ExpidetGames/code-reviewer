// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { AdvancedSettingsPageContent } from "@/workspaces/ui/advanced-settings-page";

export const metadata: Metadata = { title: "Settings · Advanced" };

// The Advanced settings of the workspace (#658): the deletion of the workspace and nothing else. Only an Owner reaches it
// (`delete_workspace`); for anybody else the page is the 404 page, the same as for a workspace that is not theirs.
export default async function AdvancedSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/advanced">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug, "delete_workspace");
  const [showPlan, showBilling] = await Promise.all([
    planPageLinkedFor(workspace.id),
    billingPageLinkedFor(),
  ]);
  return (
    <AdvancedSettingsPageContent
      workspaceSlug={workspace.slug}
      workspaceName={workspace.name}
      showPlan={showPlan}
      showBilling={showBilling}
    />
  );
}
