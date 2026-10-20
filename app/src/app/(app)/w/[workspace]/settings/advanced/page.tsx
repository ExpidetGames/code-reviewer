// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { instanceAccessOf } from "@/llm/access";
import { getWorkspaceLlm } from "@/llm/shared";
import { getNativeCatalog } from "@/native-providers/shared";
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
  const [keyStatuses, nativeStatuses, summary, showPlan] = await Promise.all([
    llm.keyServiceFor(workspaceId).statusAll(),
    // The keys of the catalog providers (#555) can be removed here too, whatever the catalog offers now.
    llm.keyServiceFor(workspaceId).nativeStatuses(),
    llm.summaryFor(workspaceId),
    planPageLinkedFor(workspaceId),
  ]);
  const catalogLabels =
    nativeStatuses.length === 0
      ? new Map<string, string>()
      : new Map(
          (await getNativeCatalog().providers()).map((provider) => [
            provider.id,
            provider.label,
          ]),
        );
  return (
    <AdvancedSettingsPageContent
      workspaceSlug={workspace.slug}
      canManageKey={can(role, "manage_llm_key")}
      keys={[
        ...keyStatuses.map(({ provider, status }) => ({
          provider,
          configured: status.state !== "not_configured",
        })),
        ...nativeStatuses.map(({ provider, status }) => {
          const label = catalogLabels.get(provider);
          return {
            provider,
            configured: status.state !== "not_configured",
            ...(label === undefined ? {} : { label }),
          };
        }),
      ]}
      instanceAccess={instanceAccessOf(summary)}
      canResetDefaults={can(role, "manage_review_defaults")}
      showPlan={showPlan}
    />
  );
}
