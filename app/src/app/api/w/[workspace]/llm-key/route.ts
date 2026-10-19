// SPDX-License-Identifier: Apache-2.0

// GET|PUT|DELETE /api/w/:workspace/llm-key: the alias of /api/w/:workspace/llm-keys/:provider for the default
// provider (#426; it was the only key slot before there were several providers). Every member reads whether a
// key is configured; setting, replacing and removing it need an Admin or an Owner (`manage_llm_key`). The key is
// write-only: no answer contains it. Protected like every workspace route: the workspace is the one in the
// address, for a member only, and `withWorkspace` checks the role before anything is read. The logic is in
// src/llm/http.ts.
import { connection } from "next/server";
import { createLlmKeyRouteHandlers } from "@/llm/http";
import { DEFAULT_LLM_PROVIDER } from "@/llm/providers/index";
import { getLlmKeyTester, getWorkspaceLlm } from "@/llm/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import type { WorkspaceAccess } from "@/workspaces/access";
import type { WorkspaceAction } from "@/workspaces/permissions";

type Context = RouteContext<"/api/w/[workspace]/llm-key">;

async function run(
  context: Context,
  action: WorkspaceAction,
  call: (
    handlers: ReturnType<typeof createLlmKeyRouteHandlers>,
    access: WorkspaceAccess,
    provider: string,
  ) => Promise<Response>,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, action, (access) =>
    call(
      createLlmKeyRouteHandlers({
        keys: getWorkspaceLlm().keyServiceFor(access.workspace.id),
        tester: getLlmKeyTester(),
      }),
      access,
      DEFAULT_LLM_PROVIDER,
    ),
  );
}

export function GET(request: Request, context: Context): Promise<Response> {
  return run(context, "view", (handlers, access, provider) =>
    handlers.get(request, access, provider),
  );
}

export function PUT(request: Request, context: Context): Promise<Response> {
  return run(context, "manage_llm_key", (handlers, access, provider) =>
    handlers.put(request, access, provider),
  );
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return run(context, "manage_llm_key", (handlers, access, provider) =>
    handlers.remove(request, access, provider),
  );
}
