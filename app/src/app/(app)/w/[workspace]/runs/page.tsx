// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { projectServiceFor } from "@/projects/shared";
import { loadRunsPage, RunsPageContent } from "@/runs/ui/runs-page";
import { lastRunSourceFor, runsServiceFor } from "@/runs/shared";
import { PageHeader } from "@/components/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";

export const metadata: Metadata = { title: "Runs" };

// Every review Code Reviewer has started in the workspace, newest first, filtered by project and status
// through the address. The page asks for the workspace itself (the second guard behind the proxy).
// `searchParams` is request data, so it is read inside the component that renders the list, behind the
// layout's <Suspense>; the page itself stays static.
export default async function RunsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/runs">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title="Runs" />
      <RunsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        searchParams={searchParams}
      />
    </>
  );
}

async function RunsContent({
  workspaceId,
  workspaceSlug,
  searchParams,
}: {
  workspaceId: string;
  workspaceSlug: string;
  searchParams: PageProps<"/w/[workspace]/runs">["searchParams"];
}) {
  const data = await loadRunsPage(await searchParams, {
    runs: runsServiceFor(workspaceId),
    projects: projectServiceFor(workspaceId),
    lastRuns: lastRunSourceFor(workspaceId),
  });
  return <RunsPageContent workspaceSlug={workspaceSlug} data={data} />;
}
