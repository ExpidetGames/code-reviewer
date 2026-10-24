// SPDX-License-Identifier: LicenseRef-Proprietary

// The call the LLM access page makes to the key mode route of its workspace (src/llm/key-mode-http.ts). Browser side; nothing throws:
// a failure is a stable code the page translates (key-mode-messages.ts). The workspace is the one in the address, never in a body.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { KeyMode } from "../../workspaces/entitlements.ts";

export type LlmKeyModeApi = {
  set(keyMode: KeyMode): Promise<RequestResult<{ keyMode: KeyMode }>>;
};

export function createLlmKeyModeApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): LlmKeyModeApi {
  const path = workspaceApiPath(workspaceSlug, "/llm-key-mode");
  return {
    set: (keyMode) => requestJson(fetchImpl, "PUT", path, { keyMode }),
  };
}

export const browserLlmKeyModeApi = (workspaceSlug: string): LlmKeyModeApi =>
  createLlmKeyModeApi((url, init) => fetch(url, init), workspaceSlug);
