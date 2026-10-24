// SPDX-License-Identifier: Apache-2.0

// The content of the Projects page: one "Needs attention" strip with the configuration hints and
// the workspace's LLM hint, then the list of repositories. `loadProjectsPage` gathers the data from
// the services (passed in, so a test uses real ones against a test database), `ProjectsPageContent`
// renders it. The page file only wires the real services.
import {
  NeedsAttention,
  type AttentionNotice,
} from "../../components/needs-attention.tsx";
import {
  describeConfigNotices,
  GITHUB_NOT_CONFIGURED_COPY,
} from "../../config-status/notices.ts";
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
import type { ManualReviewApi } from "../../manual-reviews/ui/api.ts";
import type { ProjectService } from "../service.ts";
import type { ProjectsApi } from "./api.ts";
import {
  loadProjectList,
  type LastRunSource,
  type ProjectListView,
} from "./list-view.ts";
import { ProjectList } from "./project-list.tsx";

export type ProjectsPageData = {
  list: ProjectListView;
  config: ConfigStatus;
};

export async function loadProjectsPage(deps: {
  projects: Pick<ProjectService, "listProjects">;
  lastRuns?: LastRunSource;
  config: () => ConfigStatus | Promise<ConfigStatus>;
}): Promise<ProjectsPageData> {
  return {
    list: await loadProjectList({
      projects: deps.projects,
      ...(deps.lastRuns === undefined ? {} : { lastRuns: deps.lastRuns }),
    }),
    config: await deps.config(),
  };
}

export const ACTIVATION_BLOCKED_TEXT =
  "The GitHub App is not configured, so projects cannot be activated yet.";
/** The same for a member of a workspace, who is not the one to configure it. */
export const ACTIVATION_BLOCKED_TEXT_FOR_MEMBERS = `${GITHUB_NOT_CONFIGURED_COPY} Projects cannot be activated until then.`;

export function ProjectsPageContent({
  workspaceSlug,
  audience = "member",
  canManage = true,
  canConnect = canManage,
  canStartReview = true,
  llmNotice = null,
  data,
  api,
  manualReviewApi,
}: {
  /** The workspace of the page. */
  workspaceSlug: string;
  /** Whether the person runs the instance (reads which variables are wrong) or is a member. */
  audience?: ConfigAudience;
  /** Whether the person may switch projects on and off (an Admin or an Owner). */
  canManage?: boolean;
  /** Whether the person may connect GitHub (an Admin or an Owner). */
  canConnect?: boolean;
  /** Whether the person may start a review by hand (the play button of a row, #655). */
  canStartReview?: boolean;
  /** The workspace's LLM notice, built by the page (it needs the server's summary); merged into the one strip. */
  llmNotice?: AttentionNotice | null;
  data: ProjectsPageData;
  api?: ProjectsApi;
  /** Only tests pass this: the calls of the play button's dialog. */
  manualReviewApi?: ManualReviewApi;
}) {
  // One attention region for the whole page (#173): the configuration hints and the workspace's LLM
  // hint are rows of the same strip instead of two separate notice regions.
  const notices: AttentionNotice[] = [
    ...describeConfigNotices(data.config, audience),
    ...(llmNotice === null ? [] : [llmNotice]),
  ];
  return (
    <>
      <NeedsAttention notices={notices} />
      <ProjectList
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        canConnect={canConnect}
        canStartReview={canStartReview}
        view={data.list}
        activationBlocked={
          data.config.githubApp.configured
            ? null
            : audience === "operator"
              ? ACTIVATION_BLOCKED_TEXT
              : ACTIVATION_BLOCKED_TEXT_FOR_MEMBERS
        }
        {...(api === undefined ? {} : { api })}
        {...(manualReviewApi === undefined ? {} : { manualReviewApi })}
      />
    </>
  );
}
