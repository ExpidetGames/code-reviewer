// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getWorkspaceLlm } from "@/llm/shared";
import { keyedProvidersFor } from "@/review-settings/ui/keyed-providers";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "@/review-settings/ui/global-settings-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Settings · Review defaults" };

// The review defaults of the workspace (#178): the values every project inherits, on one form with one
// explicit save. An Admin or an Owner changes them; a Member reads them.
export default async function ReviewDefaultsSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/review-defaults">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const workspaceId = workspace.id;
  const [data, showPlan, showBilling] = await Promise.all([
    loadGlobalSettingsPage({
      settings: reviewSettingsServiceFor(workspaceId),
    }),
    planPageLinkedFor(workspaceId),
    billingPageLinkedFor(),
  ]);
  // Only a workspace on its own key gets the list (and only then are its key statuses read).
  const keyedProviders = await keyedProvidersFor(
    data.model,
    getWorkspaceLlm().keyServiceFor(workspaceId),
  );
  return (
    <GlobalSettingsPageContent
      workspaceSlug={workspace.slug}
      canEdit={can(role, "manage_review_defaults")}
      showPlan={showPlan}
      showBilling={showBilling}
      {...(keyedProviders === undefined ? {} : { keyedProviders })}
      data={data}
    />
  );
}
