import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import {
  getConfigStatus,
  getGithubAppInstallUrl,
} from "@/config-status/shared";
import { getProjectService } from "@/projects/shared";
import { getLastRunSource } from "@/runs/shared";
import {
  loadProjectsPage,
  ProjectsPageContent,
} from "@/projects/ui/projects-page";
import { SyncButton } from "@/projects/ui/sync-button";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Projects" };

// The repositories the GitHub App can read, each with a switch: a repository is reviewed only while
// its project is on. The page asks for the user itself (the second guard behind the proxy).
export default async function ProjectsPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Projects"
        description="The repositories Code Reviewer watches."
        actions={<SyncButton />}
      />
      <ProjectsContent />
    </>
  );
}

async function ProjectsContent() {
  const data = await loadProjectsPage({
    projects: getProjectService(),
    // The status of each repository's newest run comes from the jobs table.
    lastRuns: getLastRunSource(),
    config: getConfigStatus,
    installUrl: getGithubAppInstallUrl,
  });
  return <ProjectsPageContent data={data} />;
}
