// SPDX-License-Identifier: Apache-2.0

// The content of the page of one run. `loadRunDetailPage` gathers the data from the service (passed
// in), `RunDetailPageContent` renders it. An id nobody has gives `not_found`: the page then shows
// the not-found page and nothing of any other run.
import Link from "next/link";
import { PageHeader } from "../../ui/page-header.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import type { RunsService } from "../runs-service.ts";
import type { RunDetailSnapshot } from "../run-view.ts";
import type { RunsApi } from "./api.ts";
import { RunDetail } from "./run-detail.tsx";

export type RunDetailPageData =
  { kind: "not_found" } | { kind: "ready"; snapshot: RunDetailSnapshot };

export async function loadRunDetailPage(
  id: string,
  deps: { runs: Pick<RunsService, "get"> },
): Promise<RunDetailPageData> {
  const snapshot = await deps.runs.get(id);
  return snapshot === undefined
    ? { kind: "not_found" }
    : { kind: "ready", snapshot };
}

export function RunDetailPageContent({
  workspaceSlug,
  data,
  api,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  data: Extract<RunDetailPageData, { kind: "ready" }>;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: RunsApi;
}) {
  const { run } = data.snapshot;
  return (
    <>
      <PageHeader
        title={`${run.project} #${String(run.prNumber)}`}
        description={`The /${run.command} run on this pull request.`}
        actions={
          <Link
            href={workspacePath(workspaceSlug, "/runs")}
            className="btn btn-secondary"
          >
            All runs
          </Link>
        }
      />
      {/* Keyed on the run. The polled data is tied to the server data it was fetched next to, so a
          page that stays mounted behind another one (Cache Components) and is shown again with
          fresh server data starts from that data. */}
      <RunDetail
        key={run.id}
        workspaceSlug={workspaceSlug}
        initial={data.snapshot}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
