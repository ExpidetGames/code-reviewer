// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { projectServiceFor } from "@/projects/shared";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
} from "@/projects/ui/project-settings-page";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";

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
  const { workspace, user } = await requireWorkspace(slug);
  return (
    <ProjectSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      user={user}
    />
  );
}

async function ProjectSettingsContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadProjectSettingsPage(repositoryId, {
    projects: projectServiceFor(workspaceId),
    settings: reviewSettingsServiceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
  });
  if (data.kind === "not_found") notFound();
  return (
    <ProjectSettingsPageContent
      workspaceSlug={workspaceSlug}
      audience={configAudienceOf(user)}
      data={data}
    />
  );
}
