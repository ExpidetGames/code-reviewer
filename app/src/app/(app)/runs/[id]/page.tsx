import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/session";
import { getRunsService } from "@/runs/shared";
import {
  loadRunDetailPage,
  RunDetailPageContent,
} from "@/runs/ui/run-detail-page";

export const metadata: Metadata = { title: "Run" };

// One run: what it was about, its status and times, the link to the review comment and the end of
// its log. The address names the run by its id. An id nobody has shows the not-found page and
// nothing of any other run; with Cache Components the data sits behind the layout's <Suspense>, so
// the response is already streaming and its HTTP status stays 200 (a status of 404 would need the
// lookup before the first byte). The data route `GET /api/runs/:id` answers a real 404.
export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  await requireUser();
  return <RunContent params={params} />;
}

async function RunContent({
  params,
}: {
  params: PageProps<"/runs/[id]">["params"];
}) {
  const { id } = await params;
  const data = await loadRunDetailPage(id, { runs: getRunsService() });
  if (data.kind === "not_found") notFound();
  return <RunDetailPageContent data={data} />;
}
