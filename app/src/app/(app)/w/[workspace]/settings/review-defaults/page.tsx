// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getWorkspaceLlm } from "@/llm/shared";
import { keyedProvidersOf } from "@/review-settings/ui/keyed-providers";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
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
  const [data, showPlan, keyStatuses] = await Promise.all([
    loadGlobalSettingsPage({
      settings: reviewSettingsServiceFor(workspaceId),
    }),
    planPageLinkedFor(workspaceId),
    getWorkspaceLlm().keyServiceFor(workspaceId).statusAll(),
  ]);
  return (
    <GlobalSettingsPageContent
      workspaceSlug={workspace.slug}
      canEdit={can(role, "manage_review_defaults")}
      showPlan={showPlan}
      keyedProviders={keyedProvidersOf(keyStatuses)}
      data={data}
    />
  );
}
