// SPDX-License-Identifier: Apache-2.0

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
import { createLlmKeyModeService } from "./key-mode-service.ts";
import { getWorkspaceLlm } from "./shared.ts";

/** The handlers of `GET` and `PUT /api/w/:workspace/llm-key-mode`, wired to the running server. */
export function getLlmKeyModeRoute(): LlmKeyModeRoute {
  const db = getDatabase();
  return createLlmKeyModeRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    service: createLlmKeyModeService({
      db,
      keysOf: (workspaceId) => getWorkspaceLlm().keyServiceFor(workspaceId),
    }),
  });
}
