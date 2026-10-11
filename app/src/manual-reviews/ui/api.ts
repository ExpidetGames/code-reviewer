// The calls the start panel makes to the app's own routes: load the open pull requests
// (`GET /api/repositories/:id/pull-requests`) and start a command
// (`POST /api/repositories/:id/reviews`, src/manual-reviews/http.ts). Browser side; no secrets here.
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
  /** Only for `ask`. */
  question?: string;
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

export function createManualReviewApi(fetchImpl: FetchLike): ManualReviewApi {
  const base = (repositoryId: string) =>
    `/api/repositories/${encodeURIComponent(repositoryId)}`;
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
export const browserManualReviewApi: ManualReviewApi = createManualReviewApi(
  (url, init) => fetch(url, init),
);
