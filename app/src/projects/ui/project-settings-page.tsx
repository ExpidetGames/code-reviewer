// SPDX-License-Identifier: Apache-2.0

// The settings page of one project (#174): the review settings form and nothing else. The page shares
// its heading, its trail and the segmented navigation with the manual-review page
// (`project-page-header`); the one "Needs attention" strip carries what a person has to act on before
// saving (the project state, the instance configuration, the workspace's LLM key). `loadProjectSettingsPage`
// gathers the data from the services (passed in), `ProjectSettingsPageContent` renders it. Every
// repository the list shows has a settings page, activated or not: the settings can be saved first and
// take effect once the project is switched on.
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
import type { AttentionNotice } from "../../components/needs-attention.tsx";
import { NeedsAttention } from "../../components/needs-attention.tsx";
import { describeConfigNotices } from "../../config-status/notices.ts";
import type { NativeFormData } from "../../native-providers/form-data.ts";
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
import { loadProjectRow } from "./list-view.ts";
import { PROJECT_STATE_NOTICE } from "./messages.ts";
import { ProjectPageHeader } from "./project-page-header.tsx";

export type ProjectSettingsPageData =
  | { kind: "not_found" }
  | {
      kind: "ready";
      row: ProjectRowView;
      model: SettingsFormModel;
      config: ConfigStatus;
      /** Whether the instance has turned Dynamic Review on (#195); the Review kind card tells the truth about it. */
      dynamicReviewEnabled: boolean;
    };

export async function loadProjectSettingsPage(
  repositoryId: string,
  deps: {
    projects: Pick<ProjectService, "findProject">;
    settings: Pick<ReviewSettingsService, "getProjectSettings">;
    config: () => ConfigStatus | Promise<ConfigStatus>;
    /** The instance gate of Dynamic Review; not given means off. */
    dynamicReviewEnabled?: () => boolean | Promise<boolean>;
  },
): Promise<ProjectSettingsPageData> {
  const row = await loadProjectRow(repositoryId, { projects: deps.projects });
  if (row === undefined) return { kind: "not_found" };
  const config = await deps.config();
  try {
    const view = await deps.settings.getProjectSettings(repositoryId);
    return {
      kind: "ready",
      row,
      model: modelFromProjectView(view),
      config,
      dynamicReviewEnabled: (await deps.dynamicReviewEnabled?.()) ?? false,
    };
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

/** What the page tells about a project that is not running reviews, as rows of the attention strip. */
export function projectStateNotices(row: ProjectRowView): AttentionNotice[] {
  if (row.status === "active") return [];
  const notice = PROJECT_STATE_NOTICE[row.status];
  return [
    {
      id: "project_state",
      severity: notice.severity,
      title: notice.title,
      detail: notice.detail,
    },
  ];
}

export function ProjectSettingsPageContent({
  workspaceSlug,
  audience = "member",
  llmNotice = null,
  keyedProviders,
  nativeCatalog,
  data,
  api,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  /** Whether the person runs the instance (reads which variables are wrong) or is a member. */
  audience?: ConfigAudience;
  /** The workspace's LLM notice, built by the page (it needs the server's summary); a row of the strip. */
  llmNotice?: AttentionNotice | null;
  /** The providers that have a stored key in the workspace (#433): the form warns about a chosen one that has none. */
  keyedProviders?: readonly string[];
  /** The models.dev catalog for the Dynamic provider and model of a workspace on its own key (#555); absent otherwise. */
  nativeCatalog?: NativeFormData;
  data: Extract<ProjectSettingsPageData, { kind: "ready" }>;
  /** Only tests pass this: a server component cannot hand functions to the client form. */
  api?: SettingsApi;
}) {
  // One attention region for the whole page (#174): the project state, the configuration hints and the
  // workspace's LLM hint are rows of the same strip instead of separate notice regions.
  const notices: AttentionNotice[] = [
    ...projectStateNotices(data.row),
    ...describeConfigNotices(data.config, audience),
    ...(llmNotice === null ? [] : [llmNotice]),
  ];
  return (
    <>
      <ProjectPageHeader
        workspaceSlug={workspaceSlug}
        row={data.row}
        active="settings"
      />
      <div className="flex flex-col gap-6 pt-6">
        <NeedsAttention notices={notices} />
        {/* Keyed on the server data: with Cache Components a page that was left stays mounted, and
            when it is shown again with fresh data the form must start from that data. */}
        <SettingsForm
          key={JSON.stringify([data.model, data.dynamicReviewEnabled])}
          workspaceSlug={workspaceSlug}
          initial={data.model}
          dynamicReviewEnabled={data.dynamicReviewEnabled}
          repositoryId={data.row.repositoryId}
          {...(keyedProviders === undefined ? {} : { keyedProviders })}
          {...(nativeCatalog === undefined ? {} : { nativeCatalog })}
          {...(api === undefined ? {} : { api })}
        />
      </div>
    </>
  );
}
