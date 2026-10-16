// SPDX-License-Identifier: Apache-2.0

// The call the plan page makes to the app's own route while it polls: `GET /api/w/:workspace/plan`
// (src/usage/http.ts). The workspace is the one of the page that makes the call. Browser side; no secrets.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { PlanView } from "../plan-view.ts";

export type PlanApi = {
  read(): Promise<RequestResult<PlanView>>;
};

export function createPlanApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): PlanApi {
  return {
    read: () =>
      requestJson<PlanView>(
        fetchImpl,
        "GET",
        workspaceApiPath(workspaceSlug, "/plan"),
      ),
  };
}

/** The real thing, for the component; tests hand in their own. */
export function browserPlanApi(workspaceSlug: string): PlanApi {
  return createPlanApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How often the page asks again: runs reserve and settle while it is open, and the limits can be changed. */
export const PLAN_POLL = {
  /** While the workspace has limits, whose numbers move with every review. */
  activeMs: 10_000,
  /** While none apply: only an operator's change can alter that. */
  idleMs: 30_000,
} as const;
