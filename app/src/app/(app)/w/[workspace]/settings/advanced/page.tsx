// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getWorkspaceLlm } from "@/llm/shared";
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
  const keyStatus = await getWorkspaceLlm().keyServiceFor(workspaceId).status();
  return (
    <AdvancedSettingsPageContent
      workspaceSlug={workspace.slug}
      canManageKey={can(role, "manage_llm_key")}
      keyConfigured={keyStatus.state !== "not_configured"}
      canResetDefaults={can(role, "manage_review_defaults")}
    />
  );
}
