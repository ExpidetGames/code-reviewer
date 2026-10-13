// SPDX-License-Identifier: Apache-2.0

// The calls the start panel makes to the app's own routes: load the open pull requests
// (`GET /api/w/:workspace/repositories/:id/pull-requests`) and start a command
// (`POST /api/w/:workspace/repositories/:id/reviews`, src/manual-reviews/http.ts). The workspace is the one
// of the page that makes the call. Browser side; no secrets here.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ReviewCommand } from "../../integrations/types.ts";
import type { OpenPullRequests, StartedReview } from "../service.ts";

export type StartRequest = {
  prNumber: number;
  command: ReviewCommand;
};

export type ManualReviewApi = {
  listPullRequests(
    repositoryId: string,
  ): Promise<RequestResult<OpenPullRequests>>;
  startReview(
    repositoryId: string,
    request: StartRequest,
  ): Promise<RequestResult<StartedReview>>;
};

export function createManualReviewApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ManualReviewApi {
  const base = (repositoryId: string) =>
    workspaceApiPath(
      workspaceSlug,
      `/repositories/${encodeURIComponent(repositoryId)}`,
    );
  return {
    listPullRequests: (repositoryId) =>
      requestJson<OpenPullRequests>(
        fetchImpl,
        "GET",
        `${base(repositoryId)}/pull-requests`,
      ),
    startReview: (repositoryId, request) =>
      requestJson<StartedReview>(
        fetchImpl,
        "POST",
        `${base(repositoryId)}/reviews`,
        request,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserManualReviewApi(workspaceSlug: string): ManualReviewApi {
  return createManualReviewApi((url, init) => fetch(url, init), workspaceSlug);
}
