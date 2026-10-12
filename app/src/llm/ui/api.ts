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

/** The answer of the test button: it worked, or a class of failure with a safe detail. */
export type TestKeyAnswer =
  { ok: true } | { ok: false; error: string; detail: string | null };

export type LlmKeyApi = {
  /** An empty `apiKey` keeps the stored one (while the provider is unchanged). */
  save(input: {
    provider: string;
    apiKey: string;
  }): Promise<RequestResult<SaveKeyAnswer>>;
  remove(): Promise<RequestResult<{ ok: true; removed: boolean }>>;
  /** Checks the typed key, or the stored one when `apiKey` is empty. */
  test(input: {
    provider: string;
    apiKey: string;
  }): Promise<RequestResult<TestKeyAnswer>>;
};

export function createLlmKeyApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): LlmKeyApi {
  const path = (rest = "") =>
    workspaceApiPath(workspaceSlug, `/llm-key${rest}`);
  return {
    save: (input) => requestJson(fetchImpl, "PUT", path(), input),
    remove: () => requestJson(fetchImpl, "DELETE", path()),
    test: (input) => requestJson(fetchImpl, "POST", path("/test"), input),
  };
}

export const browserLlmKeyApi = (workspaceSlug: string): LlmKeyApi =>
  createLlmKeyApi((url, init) => fetch(url, init), workspaceSlug);
