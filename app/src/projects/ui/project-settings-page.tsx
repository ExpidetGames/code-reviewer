// The content of the settings page of one project: what the project is, the configuration hints and
// the form with the overrides. `loadProjectSettingsPage` gathers the data from the services (passed
// in), `ProjectSettingsPageContent` renders it. A repository that is not a project yet has no
// settings to show: the page says how to make it one.
import Link from "next/link";
import { ConfigNotices } from "../../config-status/notices.tsx";
import type { ConfigStatus } from "../../config-status/status.ts";
import { EmptyState } from "../../ui/empty-state.tsx";
import { PageHeader } from "../../ui/page-header.tsx";
import { ReviewSettingsError } from "../../review-settings/errors.ts";
import type { ReviewSettingsService } from "../../review-settings/service.ts";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import {
  modelFromProjectView,
  type SettingsFormModel,
} from "../../review-settings/ui/form-model.ts";
import { SettingsForm } from "../../review-settings/ui/settings-form.tsx";
import type { ProjectService } from "../service.ts";
import type { ProjectRowView } from "./list-view.ts";
import { loadProjectList } from "./list-view.ts";

export type ProjectSettingsPageData =
  | { kind: "not_found" }
  | { kind: "no_project"; row: ProjectRowView; config: ConfigStatus }
  | {
      kind: "ready";
      row: ProjectRowView;
      model: SettingsFormModel;
      config: ConfigStatus;
    };

export async function loadProjectSettingsPage(
  repositoryId: string,
  deps: {
    projects: Pick<ProjectService, "listProjects">;
    settings: Pick<ReviewSettingsService, "getProjectSettings">;
    config: () => ConfigStatus;
  },
): Promise<ProjectSettingsPageData> {
  const { rows } = await loadProjectList({ projects: deps.projects });
  const row = rows.find((candidate) => candidate.repositoryId === repositoryId);
  if (row === undefined) return { kind: "not_found" };
  const config = deps.config();
  if (!row.hasProject) return { kind: "no_project", row, config };
  try {
    const view = await deps.settings.getProjectSettings(repositoryId);
    return { kind: "ready", row, model: modelFromProjectView(view), config };
  } catch (error) {
    // The project vanished between the two reads; it cannot, as rows are never deleted, but the
    // page then says what is true instead of failing.
    if (
      error instanceof ReviewSettingsError &&
      error.code === "REVIEW_SETTINGS_PROJECT_NOT_FOUND"
    )
      return { kind: "no_project", row, config };
    throw error;
  }
}

const STATE_TEXT: Record<ProjectRowView["status"], string> = {
  active: "Active: new pull requests are reviewed.",
  inactive: "Inactive: no new reviews start. The settings below are kept.",
  unavailable:
    "Unavailable: the GitHub App can no longer read this repository. Its settings are kept.",
};

export function ProjectSettingsPageContent({
  data,
  api,
}: {
  data: Exclude<ProjectSettingsPageData, { kind: "not_found" }>;
  /** Only tests pass this: a server component cannot hand functions to the client form. */
  api?: SettingsApi;
}) {
  const { row } = data;
  return (
    <>
      <PageHeader
        title={row.fullName}
        description="Review settings of this project."
        actions={
          <Link href="/projects" className="btn btn-secondary">
            All projects
          </Link>
        }
      />
      <ConfigNotices status={data.config} />
      {data.kind === "no_project" ? (
        <EmptyState title="This repository is not a project yet">
          Switch it on in the project list. It then starts with the default
          settings, and you can change them here.
        </EmptyState>
      ) : (
        <>
          <p className="muted">{STATE_TEXT[row.status]}</p>
          <SettingsForm
            initial={data.model}
            repositoryId={row.repositoryId}
            {...(api === undefined ? {} : { api })}
          />
        </>
      )}
    </>
  );
}
