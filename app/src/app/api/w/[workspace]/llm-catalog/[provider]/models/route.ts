// SPDX-License-Identifier: Apache-2.0

// GET /api/w/:workspace/llm-catalog/:provider/models (#555): the listed models of a catalog provider, for the model picker of a
// project on the workspace's own key. Protected like every workspace route: the workspace is the one in the address, for a member
// only. A workspace on the operator's key gets the 404 of a path that does not exist. The logic is in
// src/native-providers/models-http.ts.
import { connection } from "next/server";
import { getDatabase } from "@/db/startup";
import { keyModeForJob } from "@/llm/resolve";
import { createCatalogModelsHandler } from "@/native-providers/models-http";
import { getNativeCatalog } from "@/native-providers/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import { readEffectiveEntitlements } from "@/workspaces/effective-entitlements";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/w/[workspace]/llm-catalog/[provider]/models">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, provider } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createCatalogModelsHandler({
      catalog: getNativeCatalog(),
      ownKey: async () =>
        keyModeForJob(
          await readEffectiveEntitlements(getDatabase(), access.workspace.id),
        ) === "own",
    }).list(access, provider),
  );
}
