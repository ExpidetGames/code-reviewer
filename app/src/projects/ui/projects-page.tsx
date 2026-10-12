// SPDX-License-Identifier: Apache-2.0

// The content of the Projects page: the configuration hints on top, then the list of repositories.
// `loadProjectsPage` gathers the data from the services (passed in, so a test uses real ones against
// a test database), `ProjectsPageContent` renders it. The page file only wires the real services.
import { ConfigNotices } from "../../config-status/notices.tsx";
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
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
  /** Where the GitHub App is installed, or null while its name is not configured. */
  installUrl: string | null;
};

export async function loadProjectsPage(deps: {
  projects: Pick<ProjectService, "listProjects">;
  lastRuns?: LastRunSource;
  config: () => ConfigStatus;
  installUrl: () => string | null;
}): Promise<ProjectsPageData> {
  return {
    list: await loadProjectList({
      projects: deps.projects,
      ...(deps.lastRuns === undefined ? {} : { lastRuns: deps.lastRuns }),
    }),
    config: deps.config(),
    installUrl: deps.installUrl(),
  };
}

export const ACTIVATION_BLOCKED_TEXT =
  "The GitHub App is not configured, so projects cannot be activated yet.";
/** The same for a member of a workspace, who is not the one to configure it. */
export const ACTIVATION_BLOCKED_TEXT_FOR_MEMBERS =
  "GitHub is not set up yet, so projects cannot be activated. Ask your instance admin.";

export function ProjectsPageContent({
  workspaceSlug,
  audience = "member",
  canManage = true,
  data,
  api,
}: {
  /** The workspace of the page. */
  workspaceSlug: string;
  /** Whether the person runs the instance (reads which variables are wrong) or is a member. */
  audience?: ConfigAudience;
  /** Whether the person may switch projects on and off (an Admin or an Owner). */
  canManage?: boolean;
  data: ProjectsPageData;
  api?: ProjectsApi;
}) {
  return (
    <>
      <ConfigNotices status={data.config} audience={audience} />
      <ProjectList
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        view={data.list}
        installUrl={data.installUrl}
        activationBlocked={
          data.config.githubApp.configured
            ? null
            : audience === "operator"
              ? ACTIVATION_BLOCKED_TEXT
              : ACTIVATION_BLOCKED_TEXT_FOR_MEMBERS
        }
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
