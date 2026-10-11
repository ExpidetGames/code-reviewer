import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import { getProjectService } from "@/projects/shared";
import { loadRunsPage, RunsPageContent } from "@/runs/ui/runs-page";
import { getRunsService } from "@/runs/shared";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Runs" };

// Every review Code Reviewer has started, newest first, filtered by project and status through the
// address. The page asks for the user itself (the second guard behind the proxy). `searchParams` is
// request data, so it is read inside the component that renders the list, behind the layout's
// <Suspense>; the page itself stays static.
export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Runs"
        description="Every review Code Reviewer has started."
      />
      <RunsContent searchParams={searchParams} />
    </>
  );
}

async function RunsContent({
  searchParams,
}: {
  searchParams: PageProps<"/runs">["searchParams"];
}) {
  const data = await loadRunsPage(await searchParams, {
    runs: getRunsService(),
    projects: getProjectService(),
  });
  return <RunsPageContent data={data} />;
}
