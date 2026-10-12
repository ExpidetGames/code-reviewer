// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { getWorkspaceLlm } from "@/llm/shared";
import { LlmAccessNotice } from "@/llm/ui/llm-access-notice";
import { LlmAccessSection } from "@/llm/ui/llm-access-section";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "@/review-settings/ui/global-settings-page";
import { PageHeader } from "@/ui/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { RenameForm } from "@/workspaces/ui/rename-form";

export const metadata: Metadata = { title: "Settings" };

// The workspace (its name; an Owner renames it), the state of the instance and the default review settings
// every project of the workspace inherits (an Admin or an Owner changes them). The workspace is the one in
// the address, for a member only.
export default async function SettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title="Settings" description="How Code Reviewer behaves." />
      <section className="settings-section" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">Workspace</h2>
        {can(role, "rename_workspace") ? (
          <RenameForm
            key={workspace.name}
            workspaceSlug={workspace.slug}
            initialName={workspace.name}
          />
        ) : (
          <p>
            This workspace is called <strong>{workspace.name}</strong>. Only an
            Owner can rename it.
          </p>
        )}
      </section>
      <SettingsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        canEdit={can(role, "manage_review_defaults")}
        canManageLlmKey={can(role, "manage_llm_key")}
        user={user}
      />
    </>
  );
}

async function SettingsContent({
  workspaceId,
  workspaceSlug,
  canEdit,
  canManageLlmKey,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canEdit: boolean;
  canManageLlmKey: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadGlobalSettingsPage({
    settings: reviewSettingsServiceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
  });
  const llm = getWorkspaceLlm();
  const keyStatus = await llm.keyServiceFor(workspaceId).status();
  const summary = await llm.summaryFor(workspaceId);
  return (
    <>
      <LlmAccessNotice
        workspaceSlug={workspaceSlug}
        summary={summary}
        canManage={canManageLlmKey}
      />
      <LlmAccessSection
        workspaceSlug={workspaceSlug}
        canManage={canManageLlmKey}
        keyStatus={keyStatus}
        summary={summary}
      />
      <GlobalSettingsPageContent
        workspaceSlug={workspaceSlug}
        audience={configAudienceOf(user)}
        canEdit={canEdit}
        data={data}
      />
    </>
  );
}
