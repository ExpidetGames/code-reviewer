// SPDX-License-Identifier: Apache-2.0

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

// The review settings of one project. The address names the repository by its id in this app. An id
// nobody knows shows the not-found page; with Cache Components the data sits behind the layout's
// <Suspense>, so the response is already streaming and its HTTP status stays 200 (a status of 404
// would need the lookup before the first byte, which only data outside Suspense allows). A
// repository that was never activated has its settings page too (the settings are saved first and
// apply once the project is switched on).
export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[repositoryId]">) {
  await requireUser();
  const { repositoryId } = await params;
  return <ProjectSettingsContent repositoryId={repositoryId} />;
}

async function ProjectSettingsContent({
  repositoryId,
}: {
  repositoryId: string;
}) {
  const data = await loadProjectSettingsPage(repositoryId, {
    projects: getProjectService(),
    settings: getReviewSettingsService(),
    config: getConfigStatus,
  });
  if (data.kind === "not_found") notFound();
  return <ProjectSettingsPageContent data={data} />;
}
