// SPDX-License-Identifier: Apache-2.0

// The handler behind `GET /api/w/:workspace/llm-catalog/:provider/models` (#555): the listed models of a catalog provider, for the
// model picker of a project that runs Dynamic Review on the workspace's own key. Every member may read it (the project settings
// are readable by every member). It answers nothing to a workspace on the operator's key: the answer is the 404 of a path that
// does not exist, the same for any provider, so a member never learns a provider or a model id (principle 2 of epic #420).
// A provider is named by its slug exactly, as the key routes do; one the catalog does not offer is `provider_not_found`.
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type { NativeCatalogReader } from "./catalog.ts";

const NO_STORE = { "cache-control": "no-store" };

export type CatalogModelsHandler = {
  list(access: WorkspaceAccess, provider: string): Promise<Response>;
};

export function createCatalogModelsHandler({
  catalog,
  ownKey,
}: {
  catalog: Pick<NativeCatalogReader, "models">;
  /** Whether the models of the workspace are its own (its key mode is `own`); read for the workspace of the request. */
  ownKey: () => Promise<boolean>;
}): CatalogModelsHandler {
  return {
    async list(_access, provider) {
      if (!(await ownKey()))
        return Response.json(
          { error: "not_found" },
          { status: 404, headers: NO_STORE },
        );
      const models = /^[a-z][a-z0-9_]{1,31}$/.test(provider)
        ? await catalog.models(provider)
        : undefined;
      if (models === undefined)
        return Response.json(
          { error: "provider_not_found" },
          { status: 404, headers: NO_STORE },
        );
      return Response.json({ provider, models }, { headers: NO_STORE });
    },
  };
}
