// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { createInstanceSettingsRepository } from "@/db/repositories/instance-settings-repository";
import { getDatabase } from "@/db/startup";
import { getWorkspaceLlm } from "@/llm/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { getMembersService } from "@/workspaces/shared";
import { GeneralSettingsPageContent } from "@/workspaces/ui/general-settings-page";

export const metadata: Metadata = { title: "Settings · General" };

// The settings index (#178), the area root: the workspace name (an Owner renames it), the read-only
// instance, tenancy and member facts, and the one "Needs attention" strip. The other settings live on
// the sub-pages (`review-defaults`, `llm`, `advanced`). The workspace is the one in the address, for a
// member only.
export default async function GeneralSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <GeneralSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      workspaceName={workspace.name}
      canRename={can(role, "rename_workspace")}
      canManageLlmKey={can(role, "manage_llm_key")}
      user={user}
    />
  );
}

async function GeneralSettingsContent({
  workspaceId,
  workspaceSlug,
  workspaceName,
  canRename,
  canManageLlmKey,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  canRename: boolean;
  canManageLlmKey: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const [config, llmSummary, tenancy, members] = await Promise.all([
    // Only the instance admin gets the names of the variables that are wrong.
    getConfigStatusFor(user),
    getWorkspaceLlm().summaryFor(workspaceId),
    createInstanceSettingsRepository(getDatabase()).get("tenancy"),
    getMembersService().list(workspaceId),
  ]);
  return (
    <GeneralSettingsPageContent
      workspaceSlug={workspaceSlug}
      workspaceName={workspaceName}
      canRename={canRename}
      canManageLlmKey={canManageLlmKey}
      audience={configAudienceOf(user)}
      tenancy={tenancy === "multi" ? "multi" : "single"}
      memberCount={members.length}
      config={config}
      llmSummary={llmSummary}
    />
  );
}
