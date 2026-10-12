// SPDX-License-Identifier: Apache-2.0

// The calls the project list makes to the app's own routes: switch a project on or off
// (`PUT /api/w/:workspace/repositories/:id/project`, src/projects/http.ts) and run the sync by button
// (`POST /api/w/:workspace/integrations/sync`: the workspace's own connections only, an Admin or an Owner;
// the synchronization of the whole instance stays the instance admin's route,
// src/installation-binding/http.ts). The workspace of both calls is the one of the page that makes them.
// Browser side; no secrets here.
import type { SyncAnswer } from "../../integrations/sync/http.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

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
    sync: () =>
      requestJson<SyncAnswer>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/integrations/sync"),
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserProjectsApi(workspaceSlug: string): ProjectsApi {
  return createProjectsApi((url, init) => fetch(url, init), workspaceSlug);
}

/** The synchronization of the whole instance: the instance admin's route of the admin portal. */
export const INSTANCE_SYNC_PATH = "/api/admin/integrations/sync";

export type InstanceSyncApi = Pick<ProjectsApi, "sync">;

export function createInstanceSyncApi(fetchImpl: FetchLike): InstanceSyncApi {
  return {
    sync: () => requestJson<SyncAnswer>(fetchImpl, "POST", INSTANCE_SYNC_PATH),
  };
}

export const browserInstanceSyncApi: InstanceSyncApi = createInstanceSyncApi(
  (url, init) => fetch(url, init),
);
