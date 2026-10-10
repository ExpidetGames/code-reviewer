// The wiring of the running server: the LLM configuration as the process environment has it right
// now. Read on every call, never cached, so a changed value is used by the next claim or page.
import "server-only";
import { resolveLlmAccess, type LlmAccessResult } from "./access.ts";
import { loadLlmConfig, type LlmConfigState } from "./config.ts";
import { describeLlmStatus, type LlmStatus } from "./status.ts";

export function getLlmConfigState(): LlmConfigState {
  return loadLlmConfig(process.env);
}

/** For the claim of the runner API: the access for one job, or `llm_not_configured`. */
export function getLlmAccess(): LlmAccessResult {
  return resolveLlmAccess(getLlmConfigState());
}

/** For the settings page (CR-34): "LLM not configured" with the variable names, or provider and model. */
export function getLlmStatus(): LlmStatus {
  return describeLlmStatus(getLlmConfigState());
}
