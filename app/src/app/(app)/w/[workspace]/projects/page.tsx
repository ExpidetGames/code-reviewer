// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { projectServiceFor } from "@/projects/shared";
import { lastRunSourceFor } from "@/runs/shared";
import {
  loadProjectsPage,
  ProjectsPageContent,
} from "@/projects/ui/projects-page";
import { SyncButton } from "@/projects/ui/sync-button";
import { PageHeader } from "@/ui/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Projects" };

// The repositories the GitHub App can read, each with a switch: a repository is reviewed only while
// its project is on. The workspace is the one in the address, for a member only: the page asks for it
// itself (the second guard behind the proxy), and everything below works in that workspace.
export default async function ProjectsPage({
  params,
}: PageProps<"/w/[workspace]/projects">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  const canManage = can(role, "manage_projects");
  const canConnect = can(role, "manage_connections");
  return (
    <>
      <PageHeader
        title="Projects"
        description="The repositories Code Reviewer watches."
        actions={
          // The synchronization of the workspace: it reads the workspace's own connections, for an Owner or
          // an Admin (the instance admin's synchronization of everything is a route of the admin portal).
          canConnect ? <SyncButton workspaceSlug={workspace.slug} /> : null
        }
      />
      <ProjectsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        canManage={canManage}
        canConnect={canConnect}
        user={user}
      />
    </>
  );
}

async function ProjectsContent({
  workspaceId,
  workspaceSlug,
  canManage,
  canConnect,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  canConnect: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadProjectsPage({
    projects: projectServiceFor(workspaceId),
    // The status of each repository's newest run comes from the jobs table.
    lastRuns: lastRunSourceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
  });
  return (
    <ProjectsPageContent
      workspaceSlug={workspaceSlug}
      audience={configAudienceOf(user)}
      canManage={canManage}
      canConnect={canConnect}
      data={data}
    />
  );
}
