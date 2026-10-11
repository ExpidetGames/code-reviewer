// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getConfigStatus } from "@/config-status/shared";
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
  const { workspace, role } = await requireWorkspace(slug);
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
      />
    </>
  );
}

async function SettingsContent({
  workspaceId,
  workspaceSlug,
  canEdit,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canEdit: boolean;
}) {
  const data = await loadGlobalSettingsPage({
    settings: reviewSettingsServiceFor(workspaceId),
    config: getConfigStatus,
  });
  return (
    <GlobalSettingsPageContent
      workspaceSlug={workspaceSlug}
      canEdit={canEdit}
      data={data}
    />
  );
}
