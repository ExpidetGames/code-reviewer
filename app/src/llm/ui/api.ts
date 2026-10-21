// SPDX-License-Identifier: Apache-2.0

// The calls the settings page makes to the LLM key routes of its workspace (src/llm/http.ts). Browser side.
// The key travels in the body of a save or a test and in nothing else: not in an address, not in a header the
// page sets. Nothing throws; a failure is a stable code the page translates (messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";

export type SaveKeyAnswer = {
  ok: true;
  changed: boolean;
  key: WorkspaceLlmKeyStatus;
};

/**
 * The answer of the test button: it worked, the provider has no way to check a key (`verified: false`, #555: not an error and not
 * a verified key), or a class of failure with a safe detail.
 */
export type TestKeyAnswer =
  | { ok: true; verified?: false }
  | { ok: false; error: string; detail: string | null };

/** Every call is for the key of one provider (`/llm-keys/:provider`, #426). */
export type LlmKeyApi = {
  /** An empty `apiKey` keeps the stored key of that provider. */
  save(input: {
    provider: string;
    apiKey: string;
  }): Promise<RequestResult<SaveKeyAnswer>>;
  remove(
    provider: string,
  ): Promise<RequestResult<{ ok: true; removed: boolean }>>;
  /** Checks the typed key, or the stored one of that provider when `apiKey` is empty. */
  test(input: {
    provider: string;
    apiKey: string;
  }): Promise<RequestResult<TestKeyAnswer>>;
};

export function createLlmKeyApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): LlmKeyApi {
  const path = (provider: string, rest = "") =>
    workspaceApiPath(
      workspaceSlug,
      `/llm-keys/${encodeURIComponent(provider)}${rest}`,
    );
  // The provider is in the address; the body holds the key only.
  return {
    save: ({ provider, apiKey }) =>
      requestJson(fetchImpl, "PUT", path(provider), { apiKey }),
    remove: (provider) => requestJson(fetchImpl, "DELETE", path(provider)),
    test: ({ provider, apiKey }) =>
      requestJson(fetchImpl, "POST", path(provider, "/test"), { apiKey }),
  };
}

export const browserLlmKeyApi = (workspaceSlug: string): LlmKeyApi =>
  createLlmKeyApi((url, init) => fetch(url, init), workspaceSlug);
