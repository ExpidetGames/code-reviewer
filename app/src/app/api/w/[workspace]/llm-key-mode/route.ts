// SPDX-License-Identifier: Apache-2.0

// GET and PUT /api/w/:workspace/llm-key-mode: whose key the reviews of the workspace run on while billing is on, our models or its own
// provider key (ADR 0006, P3, D4; #496). Every member reads the choice; an Owner or an Admin (`manage_llm_key`) sets it. A missing path
// while billing is off; same site only for a change. A review that started is never touched by a change: the choice is read when a job
// is claimed. The logic is in src/llm/key-mode-http.ts.
import { connection } from "next/server";
import { getLlmKeyModeRoute } from "@/llm/key-mode-shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/llm-key-mode">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getLlmKeyModeRoute().get(request, workspace, (handler) =>
    withWorkspace(workspace, "view", handler),
  );
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/llm-key-mode">,
): Promise<Response> {
  await connection();
  const { workspace } = await context.params;
  return getLlmKeyModeRoute().put(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_llm_key", handler),
  );
}
