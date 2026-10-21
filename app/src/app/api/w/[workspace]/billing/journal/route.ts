// SPDX-License-Identifier: Apache-2.0

// GET /api/w/:workspace/billing/journal: one page of the balance journal of the workspace, newest first (ADR 0006, 2.5; #505).
// Every member of the workspace (`view`); a missing path while billing is off. Final prices only. The logic is in
// src/billing/journal-http.ts.
import { connection } from "next/server";
import { getJournalRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/journal">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getJournalRoute().get(request, workspace, (handler) =>
    withWorkspace(workspace, "view", handler),
  );
}
