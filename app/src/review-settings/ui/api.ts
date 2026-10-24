// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the settings form makes to the app's own routes (src/review-settings/http.ts): save the
// defaults of the workspace or the overrides of one project, and reset a project to the defaults. The
// workspace is the one of the page that makes the call. Browser side.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

export type SettingsApi = {
  /**
   * Replaces the whole set of the layer with these fields; the answer is the new view. The workspace defaults say which
   * version of them the form was built from (`expectedUpdatedAt`, #676), so a save over newer ones is refused.
   */
  save(
    settings: Record<string, unknown>,
    options?: { expectedUpdatedAt: string | null },
  ): Promise<RequestResult<unknown>>;
  /** Removes every override of a project; only a project has this. */
  reset?: () => Promise<RequestResult<unknown>>;
};

export function createGlobalSettingsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): SettingsApi {
  return {
    save: (settings, options) =>
      requestJson(
        fetchImpl,
        "PUT",
        workspaceApiPath(workspaceSlug, "/review-settings"),
        options === undefined
          ? { settings }
          : { settings, expectedUpdatedAt: options.expectedUpdatedAt },
      ),
  };
}

export function createProjectSettingsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
  repositoryId: string,
): SettingsApi {
  const url = workspaceApiPath(
    workspaceSlug,
    `/repositories/${encodeURIComponent(repositoryId)}/project/settings`,
  );
  return {
    save: (settings) => requestJson(fetchImpl, "PUT", url, { settings }),
    reset: () => requestJson(fetchImpl, "DELETE", url),
  };
}

const browserFetch: FetchLike = (url, init) => fetch(url, init);

export function browserGlobalSettingsApi(workspaceSlug: string): SettingsApi {
  return createGlobalSettingsApi(browserFetch, workspaceSlug);
}

export function browserProjectSettingsApi(
  workspaceSlug: string,
  repositoryId: string,
): SettingsApi {
  return createProjectSettingsApi(browserFetch, workspaceSlug, repositoryId);
}
