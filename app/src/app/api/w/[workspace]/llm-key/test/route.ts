// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/llm-key/test: the alias of /llm-keys/:provider/test for the default provider (#426); asks the provider whether the key is accepted (the "test key" button),
// with the key typed into the field or, when it is empty, the stored one. An Admin or an Owner only
// (`manage_llm_key`), limited per workspace and for the instance. The provider's address is its own API and
// nothing from the request. The logic is in src/llm/http.ts.
import { connection } from "next/server";
import { createLlmKeyRouteHandlers } from "@/llm/http";
import { DEFAULT_LLM_PROVIDER } from "@/llm/providers/index";
import { getLlmKeyTester, getWorkspaceLlm } from "@/llm/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/llm-key/test">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_llm_key", (access) =>
    createLlmKeyRouteHandlers({
      keys: getWorkspaceLlm().keyServiceFor(access.workspace.id),
      tester: getLlmKeyTester(),
    }).test(request, access, DEFAULT_LLM_PROVIDER),
  );
}
