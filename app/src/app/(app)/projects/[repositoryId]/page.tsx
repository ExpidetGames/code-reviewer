import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/session";
import { getConfigStatus } from "@/config-status/shared";
import { getProjectService } from "@/projects/shared";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
} from "@/projects/ui/project-settings-page";
import { getReviewSettingsService } from "@/review-settings/shared";

export const metadata: Metadata = { title: "Project settings" };

// The review settings of one project. The address names the repository by its id in this app;
// an id nobody knows is a 404, a repository that is not a project yet says how to make it one.
export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[repositoryId]">) {
  await requireUser();
  const { repositoryId } = await params;
  const data = await loadProjectSettingsPage(repositoryId, {
    projects: getProjectService(),
    settings: getReviewSettingsService(),
    config: getConfigStatus,
  });
  if (data.kind === "not_found") notFound();
  return <ProjectSettingsPageContent data={data} />;
}
