// The calls the runs pages make to the app's own routes while they poll: the list
// (`GET /api/runs`, src/runs/http.ts) and one run (`GET /api/runs/:id`). Browser side; no secrets.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type {
  RunDetailSnapshot,
  RunsFilter,
  RunsSnapshot,
} from "../run-view.ts";

export type { RunsFilter };

export type RunsApi = {
  list(filter: RunsFilter): Promise<RequestResult<RunsSnapshot>>;
  detail(id: string): Promise<RequestResult<RunDetailSnapshot>>;
};

export function createRunsApi(fetchImpl: FetchLike): RunsApi {
  return {
    list(filter) {
      const query = new URLSearchParams();
      if (filter.repositoryId !== undefined)
        query.set("repository", filter.repositoryId);
      if (filter.status !== undefined) query.set("status", filter.status);
      const text = query.toString();
      return requestJson<RunsSnapshot>(
        fetchImpl,
        "GET",
        text === "" ? "/api/runs" : `/api/runs?${text}`,
      );
    },
    detail: (id) =>
      requestJson<RunDetailSnapshot>(
        fetchImpl,
        "GET",
        `/api/runs/${encodeURIComponent(id)}`,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export const browserRunsApi: RunsApi = createRunsApi((url, init) =>
  fetch(url, init),
);

/** How often the pages ask again: quickly while a run can change, slowly to notice new runs. */
export const RUNS_POLL = {
  activeMs: 3000,
  /** The list keeps asking, so a run that starts after the page was opened shows up. */
  listIdleMs: 5000,
} as const;
