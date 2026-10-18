// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { instanceAccessOf } from "@/llm/access";
import { getWorkspaceLlm } from "@/llm/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { AdvancedSettingsPageContent } from "@/workspaces/ui/advanced-settings-page";

export const metadata: Metadata = { title: "Settings · Advanced" };

// The Advanced settings of the workspace (#178): the destructive actions, each in a danger zone with a
// confirmation. Removing the key needs `manage_llm_key`, resetting the defaults needs
// `manage_review_defaults`; the workspace is the one in the address, for a member only.
export default async function AdvancedSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/advanced">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const workspaceId = workspace.id;
  const llm = getWorkspaceLlm();
  const [keyStatuses, summary, showPlan] = await Promise.all([
    llm.keyServiceFor(workspaceId).statusAll(),
    llm.summaryFor(workspaceId),
    planPageLinkedFor(workspaceId),
  ]);
  // A managed workspace has no key of its own to remove, and the provider behind the instance's access is not for it to
  // read (#435): the page lists no provider, as the LLM access page does.
  const managed = instanceAccessOf(summary) !== null;
  return (
    <AdvancedSettingsPageContent
      workspaceSlug={workspace.slug}
      canManageKey={can(role, "manage_llm_key")}
      keys={
        managed
          ? []
          : keyStatuses.map(({ provider, status }) => ({
              provider,
              configured: status.state !== "not_configured",
            }))
      }
      canResetDefaults={can(role, "manage_review_defaults")}
      showPlan={showPlan}
    />
  );
}
