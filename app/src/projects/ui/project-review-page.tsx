// SPDX-License-Identifier: Apache-2.0

// The manual-review page of one project (#174): the "Review now" panel and nothing of the settings.
// The page shares its heading, its trail and the segmented navigation with the settings page
// (`project-page-header`), and it shows the workspace's LLM-key hint as a row of the same attention
// strip (a start does not check the key, so the person reads why before the run fails). Only an active
// project can start a review by hand; every other state says why as a note, and the settings stay
// reachable through the segments. `loadProjectReviewPage` reads the row, `ProjectReviewPageContent`
// renders it. The repository name is untrusted GitHub text, rendered as text.
import { Alert } from "../../components/ui/alert.tsx";
import {
  NeedsAttention,
  type AttentionNotice,
} from "../../components/needs-attention.tsx";
import type { ManualReviewApi } from "../../manual-reviews/ui/api.ts";
import { StartReviewPanel } from "../../manual-reviews/ui/start-review-panel.tsx";
import type { ProjectService } from "../service.ts";
import type { ProjectRowView } from "./list-view.ts";
import { loadProjectRow } from "./list-view.ts";
import { ProjectPageHeader } from "./project-page-header.tsx";

export type ProjectReviewPageData =
  { kind: "not_found" } | { kind: "ready"; row: ProjectRowView };

export async function loadProjectReviewPage(
  repositoryId: string,
  deps: { projects: Pick<ProjectService, "findProject"> },
): Promise<ProjectReviewPageData> {
  const row = await loadProjectRow(repositoryId, { projects: deps.projects });
  return row === undefined ? { kind: "not_found" } : { kind: "ready", row };
}

export function ProjectReviewPageContent({
  workspaceSlug,
  llmNotice = null,
  data,
  manualReviewApi,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  /** The workspace's LLM notice, built by the page (it needs the server's summary); a row of the strip. */
  llmNotice?: AttentionNotice | null;
  data: Extract<ProjectReviewPageData, { kind: "ready" }>;
  /** Only tests pass this: a server component cannot hand functions to the client panel. */
  manualReviewApi?: ManualReviewApi;
}) {
  const { row } = data;
  return (
    <>
      <ProjectPageHeader
        workspaceSlug={workspaceSlug}
        row={row}
        active="review"
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        {/* The workspace's LLM hint is a row of the page's one attention strip, not its own region:
            starting a review does not check the key, so the person reads why before the run fails. */}
        <NeedsAttention notices={llmNotice === null ? [] : [llmNotice]} />
        {/* Keyed on the repository: a panel that Cache Components kept mounted for another project
            must not show its pull requests. Only an active project can be started by hand. */}
        {row.status === "active" ? (
          <StartReviewPanel
            key={row.repositoryId}
            workspaceSlug={workspaceSlug}
            repositoryId={row.repositoryId}
            {...(manualReviewApi === undefined ? {} : { api: manualReviewApi })}
          />
        ) : (
          <Alert variant="warning" role="note">
            Reviews can be started by hand only while the project is active.
          </Alert>
        )}
      </div>
    </>
  );
}
