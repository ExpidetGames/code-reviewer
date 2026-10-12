// SPDX-License-Identifier: Apache-2.0

// The content of the settings page of one project: what the project is, the configuration hints and
// the form with the overrides. `loadProjectSettingsPage` gathers the data from the services (passed
// in), `ProjectSettingsPageContent` renders it. Every repository the list shows has a settings page,
// activated or not: the settings can be saved first and take effect once the project is switched on.
import Link from "next/link";
import { workspacePath } from "../../workspaces/paths.ts";
import { ConfigNotices } from "../../config-status/notices.tsx";
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
import { PageHeader } from "../../ui/page-header.tsx";
import { ReviewSettingsError } from "../../review-settings/errors.ts";
import type { ManualReviewApi } from "../../manual-reviews/ui/api.ts";
import { StartReviewPanel } from "../../manual-reviews/ui/start-review-panel.tsx";
import type { ReviewSettingsService } from "../../review-settings/service.ts";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import {
  modelFromProjectView,
  type SettingsFormModel,
} from "../../review-settings/ui/form-model.ts";
import { SettingsForm } from "../../review-settings/ui/settings-form.tsx";
import type { ProjectService } from "../service.ts";
import { PROJECT_STATE_TEXT } from "./messages.ts";
import type { ProjectRowView } from "./list-view.ts";
import { loadProjectRow } from "./list-view.ts";

export type ProjectSettingsPageData =
  | { kind: "not_found" }
  | {
      kind: "ready";
      row: ProjectRowView;
      model: SettingsFormModel;
      config: ConfigStatus;
    };

export async function loadProjectSettingsPage(
  repositoryId: string,
  deps: {
    projects: Pick<ProjectService, "findProject">;
    settings: Pick<ReviewSettingsService, "getProjectSettings">;
    config: () => ConfigStatus | Promise<ConfigStatus>;
  },
): Promise<ProjectSettingsPageData> {
  const row = await loadProjectRow(repositoryId, { projects: deps.projects });
  if (row === undefined) return { kind: "not_found" };
  const config = await deps.config();
  try {
    const view = await deps.settings.getProjectSettings(repositoryId);
    return { kind: "ready", row, model: modelFromProjectView(view), config };
  } catch (error) {
    // The repository vanished between the two reads (it stopped being listed and had no project).
    if (
      error instanceof ReviewSettingsError &&
      error.code === "REVIEW_SETTINGS_PROJECT_NOT_FOUND"
    )
      return { kind: "not_found" };
    throw error;
  }
}

export function ProjectSettingsPageContent({
  workspaceSlug,
  audience = "member",
  data,
  api,
  manualReviewApi,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  /** Whether the person runs the instance (reads which variables are wrong) or is a member. */
  audience?: ConfigAudience;
  data: Extract<ProjectSettingsPageData, { kind: "ready" }>;
  /** Only tests pass this: a server component cannot hand functions to the client form. */
  api?: SettingsApi;
  /** Same, for the "Review now" panel. */
  manualReviewApi?: ManualReviewApi;
}) {
  const { row } = data;
  return (
    <>
      <PageHeader
        title={row.fullName}
        description="Review settings of this project."
        actions={
          <Link
            href={workspacePath(workspaceSlug, "/projects")}
            className="btn btn-secondary"
          >
            All projects
          </Link>
        }
      />
      <ConfigNotices status={data.config} audience={audience} />
      <p className="muted">{PROJECT_STATE_TEXT[row.status]}</p>
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
        <p className="muted small">
          Reviews can be started by hand only while the project is active.
        </p>
      )}
      {/* Keyed on the server data: with Cache Components a page that was left stays mounted, and
          when it is shown again with fresh data the form must start from that data. */}
      <SettingsForm
        key={JSON.stringify(data.model)}
        workspaceSlug={workspaceSlug}
        initial={data.model}
        repositoryId={row.repositoryId}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
