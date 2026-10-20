// SPDX-License-Identifier: Apache-2.0

// The call the model picker makes to the models route of its workspace (src/native-providers/models-http.ts). Browser side.
// Nothing throws; a failure is a stable code.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { NativeModelView } from "../catalog.ts";

export type CatalogModelsAnswer = {
  provider: string;
  models: NativeModelView[];
};

export type CatalogModelsApi = {
  /** The listed models of a catalog provider, by its slug. */
  models(provider: string): Promise<RequestResult<CatalogModelsAnswer>>;
};

export function createCatalogModelsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): CatalogModelsApi {
  return {
    models: (provider) =>
      requestJson(
        fetchImpl,
        "GET",
        workspaceApiPath(
          workspaceSlug,
          `/llm-catalog/${encodeURIComponent(provider)}/models`,
        ),
      ),
  };
}

export const browserCatalogModelsApi = (
  workspaceSlug: string,
): CatalogModelsApi =>
  createCatalogModelsApi((url, init) => fetch(url, init), workspaceSlug);
