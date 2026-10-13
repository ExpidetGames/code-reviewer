// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { getWorkspaceLlm } from "@/llm/shared";
import { llmAccessAttention } from "@/llm/ui/llm-access-notice";
import { projectServiceFor } from "@/projects/shared";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
} from "@/projects/ui/project-settings-page";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Project settings" };

// The review settings of one project. The address names the workspace and the repository by its id in this
// app. An id nobody has in this workspace (also one of another workspace) shows the not-found page; with
// Cache Components the data sits behind the layout's <Suspense>, so the response is already streaming and
// its HTTP status stays 200 (a status of 404 would need the lookup before the first byte, which only data
// outside Suspense allows). A repository that was never activated has its settings page too (the settings
// are saved first and apply once the project is switched on).
export default async function ProjectSettingsPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]">) {
  const { workspace: slug, repositoryId } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <ProjectSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      canManageLlmKey={can(role, "manage_llm_key")}
      user={user}
    />
  );
}

async function ProjectSettingsContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  canManageLlmKey,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  canManageLlmKey: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadProjectSettingsPage(repositoryId, {
    projects: projectServiceFor(workspaceId),
    settings: reviewSettingsServiceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
  });
  if (data.kind === "not_found") notFound();
  // The workspace's LLM hint is a row of the page's one "Needs attention" strip, not its own region.
  const llmNotice = llmAccessAttention({
    workspaceSlug,
    summary: await getWorkspaceLlm().summaryFor(workspaceId),
    canManage: canManageLlmKey,
  });
  return (
    <ProjectSettingsPageContent
      workspaceSlug={workspaceSlug}
      audience={configAudienceOf(user)}
      llmNotice={llmNotice}
      data={data}
    />
  );
}
