// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { projectServiceFor } from "@/projects/shared";
import {
  loadProjectReviewPage,
  ProjectReviewPageContent,
} from "@/projects/ui/project-review-page";
import { requireWorkspace } from "@/workspaces/access-runtime";

export const metadata: Metadata = { title: "Review now" };

// The manual-review page of one project (#174). The address names the workspace and the repository by
// its id in this app; the page is reached from the primary action of the settings page and from the
// segmented navigation. An id nobody has in this workspace (also one of another workspace) shows the
// not-found page; with Cache Components the data sits behind the layout's <Suspense>, so the response
// is already streaming and its HTTP status stays 200. Only an active project can start a review; the
// settings stay reachable while it is not.
export default async function ProjectReviewPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/review">) {
  const { workspace: slug, repositoryId } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <ProjectReviewContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
    />
  );
}

async function ProjectReviewContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
}) {
  const data = await loadProjectReviewPage(repositoryId, {
    projects: projectServiceFor(workspaceId),
  });
  if (data.kind === "not_found") notFound();
  return <ProjectReviewPageContent workspaceSlug={workspaceSlug} data={data} />;
}
