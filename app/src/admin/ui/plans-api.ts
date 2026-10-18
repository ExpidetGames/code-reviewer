// SPDX-License-Identifier: Apache-2.0

// The calls the plans page makes to its own data routes (src/billing/plans-http.ts). Browser side; nothing throws, a
// failure is a stable code the page translates (plans-messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type {
  PlanKind,
  PlanMetadata,
  PlanTerms,
  PlansView,
} from "./plans-view.ts";

/** What the server answers to a write: the whole list, and the plan that lost the Popular badge, if any. */
export type PlansWriteAnswer = {
  ok: true;
  clearedPopular: string | null;
  plans: PlansView;
};

export type NewPlanBody = {
  planKey: string;
  kind: Exclude<PlanKind, "free">;
} & PlanMetadata & { terms?: PlanTerms };

export type PlanChange =
  | { metadata: Partial<PlanMetadata> }
  | { terms: { basedOnVersion: number; terms: PlanTerms } }
  | { archived: boolean }
  /** Links a Paddle price to the slot of the current version (#439). No amount: it is the version's and Paddle's. */
  | {
      priceLink: {
        versionNumber: number;
        interval: "month" | "year";
        paddlePriceId: string;
      };
    }
  /** Reads the linked prices of the plan again from Paddle. */
  | { refreshPrices: true };

export type PlansApi = {
  create(body: NewPlanBody): Promise<RequestResult<PlansWriteAnswer>>;
  change(
    planKey: string,
    change: PlanChange,
  ): Promise<RequestResult<PlansWriteAnswer>>;
  remove(planKey: string): Promise<RequestResult<PlansWriteAnswer>>;
};

const BASE = "/api/admin/billing/plans";

export function createPlansApi(fetchImpl: FetchLike): PlansApi {
  return {
    create: (body) => requestJson(fetchImpl, "POST", BASE, body),
    change: (planKey, change) =>
      requestJson(
        fetchImpl,
        "PUT",
        `${BASE}/${encodeURIComponent(planKey)}`,
        change,
      ),
    remove: (planKey) =>
      requestJson(
        fetchImpl,
        "DELETE",
        `${BASE}/${encodeURIComponent(planKey)}`,
      ),
  };
}

export const browserPlansApi = createPlansApi((url, init) => fetch(url, init));
