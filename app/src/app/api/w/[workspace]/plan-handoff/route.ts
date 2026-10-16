// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/plan-handoff: the "Manage plan" button. An Owner or an Admin is sent to the page the
// operator configured for this instance, with a single-use token that says who they are (src/plan-handoff/README.md).
// A missing path while no page is configured; same site only; limited per person and workspace. The logic is in
// src/plan-handoff/http.ts.
import { connection } from "next/server";
import { getPlanHandoffRoute } from "@/plan-handoff/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/plan-handoff">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getPlanHandoffRoute().post(request, workspace);
}
