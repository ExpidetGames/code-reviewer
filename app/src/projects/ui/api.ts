// SPDX-License-Identifier: Apache-2.0

// The calls the project list makes to the app's own routes: switch a project on or off
// (`PUT /api/w/:workspace/repositories/:id/project`, src/projects/http.ts) and run the sync by button
// (`POST /api/admin/integrations/sync`, the instance admin's route: the synchronization reads every
// connection of the instance, it is not about one workspace; src/integrations/sync/http.ts). The workspace
// of the other call is the one of the page that makes it. Browser side; no secrets here.
import type { SyncAnswer } from "../../integrations/sync/http.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

/** The synchronization is the instance's, not a workspace's: the admin portal's data route. */
export const SYNC_PATH = "/api/admin/integrations/sync";

export type SetActiveAnswer = {
  repositoryId: string;
  projectId: string | null;
  active: boolean;
  changed: boolean;
};

export type ProjectsApi = {
  setActive(
    repositoryId: string,
    active: boolean,
  ): Promise<RequestResult<SetActiveAnswer>>;
  sync(): Promise<RequestResult<SyncAnswer>>;
};

export function createProjectsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ProjectsApi {
  return {
    setActive: (repositoryId, active) =>
      requestJson<SetActiveAnswer>(
        fetchImpl,
        "PUT",
        workspaceApiPath(
          workspaceSlug,
          `/repositories/${encodeURIComponent(repositoryId)}/project`,
        ),
        { active },
      ),
    sync: () => requestJson<SyncAnswer>(fetchImpl, "POST", SYNC_PATH),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserProjectsApi(workspaceSlug: string): ProjectsApi {
  return createProjectsApi((url, init) => fetch(url, init), workspaceSlug);
}
