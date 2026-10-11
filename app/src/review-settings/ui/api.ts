// SPDX-License-Identifier: Apache-2.0

// The calls the settings form makes to the app's own routes (src/review-settings/http.ts): save the
// global defaults or the overrides of one project, and reset a project to the defaults. Browser side.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

export type SettingsApi = {
  /** Replaces the whole set of the layer with these fields; the answer is the new view. */
  save(settings: Record<string, unknown>): Promise<RequestResult<unknown>>;
  /** Removes every override of a project; only a project has this. */
  reset?: () => Promise<RequestResult<unknown>>;
};

export function createGlobalSettingsApi(fetchImpl: FetchLike): SettingsApi {
  return {
    save: (settings) =>
      requestJson(fetchImpl, "PUT", "/api/review-settings", { settings }),
  };
}

export function createProjectSettingsApi(
  fetchImpl: FetchLike,
  repositoryId: string,
): SettingsApi {
  const url = `/api/repositories/${encodeURIComponent(repositoryId)}/project/settings`;
  return {
    save: (settings) => requestJson(fetchImpl, "PUT", url, { settings }),
    reset: () => requestJson(fetchImpl, "DELETE", url),
  };
}

const browserFetch: FetchLike = (url, init) => fetch(url, init);

export const browserGlobalSettingsApi = createGlobalSettingsApi(browserFetch);

export function browserProjectSettingsApi(repositoryId: string): SettingsApi {
  return createProjectSettingsApi(browserFetch, repositoryId);
}
