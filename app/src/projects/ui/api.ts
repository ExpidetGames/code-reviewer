// SPDX-License-Identifier: Apache-2.0

// The calls the project list makes to the app's own routes: switch a project on or off
// (`PUT /api/repositories/:id/project`, src/projects/http.ts) and run the sync by button
// (`POST /api/integrations/sync`, src/integrations/sync/http.ts). Browser side; no secrets here.
import type { SyncAnswer } from "../../integrations/sync/http.ts";
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

export function createProjectsApi(fetchImpl: FetchLike): ProjectsApi {
  return {
    setActive: (repositoryId, active) =>
      requestJson<SetActiveAnswer>(
        fetchImpl,
        "PUT",
        `/api/repositories/${encodeURIComponent(repositoryId)}/project`,
        { active },
      ),
    sync: () =>
      requestJson<SyncAnswer>(fetchImpl, "POST", "/api/integrations/sync"),
  };
}

/** The real thing, for the components; tests hand in their own. */
export const browserProjectsApi: ProjectsApi = createProjectsApi((url, init) =>
  fetch(url, init),
);
