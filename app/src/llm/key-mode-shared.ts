// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server for the key mode a workspace chooses (#496): its route and what the LLM access page reads. Billing
// on is the one condition: with billing off nothing here is asked.
import "server-only";
import { notFound } from "next/navigation";
import { isBillingOn } from "../billing/enabled.ts";
import { getDatabase } from "../db/startup.ts";
import {
  createLlmKeyModeRoute,
  type LlmKeyModeRoute,
} from "./key-mode-http.ts";
import {
  createLlmKeyModeService,
  type LlmKeyModeService,
} from "./key-mode-service.ts";
import { getWorkspaceLlm } from "./shared.ts";

/** The key mode service of the running server. */
export function getLlmKeyModeService(): LlmKeyModeService {
  return createLlmKeyModeService({
    db: getDatabase(),
    keysOf: (workspaceId) => getWorkspaceLlm().keyServiceFor(workspaceId),
  });
}

/** The handlers of `GET` and `PUT /api/w/:workspace/llm-key-mode`, wired to the running server. */
export function getLlmKeyModeRoute(): LlmKeyModeRoute {
  const db = getDatabase();
  return createLlmKeyModeRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    service: getLlmKeyModeService(),
  });
}
