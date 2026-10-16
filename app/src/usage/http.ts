// SPDX-License-Identifier: Apache-2.0

// The answer of `GET /api/w/:workspace/plan`, the route the plan page polls (src/app/api/w/[workspace]/plan/). The
// view is already the boundary to the browser (`plan-view.ts`); the answer adds only that it is never cached,
// because the numbers change with every review.
import type { PlanView } from "./plan-view.ts";

export function planResponse(view: PlanView): Response {
  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
