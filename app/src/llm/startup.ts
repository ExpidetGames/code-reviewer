// SPDX-License-Identifier: Apache-2.0

// What the server says about the LLM access when it starts. The LLM key is a matter of each workspace now
// (src/llm/resolve.ts), so an instance without `LLM_*` variables is normal and says nothing. What is reported is a
// legacy variable that is SET BUT WRONG, and an optional one that is ignored. A problem is one warning with the
// code and the variable names and never stops the start: the rest of the app works without an LLM, the UI shows
// the problem and a job fails with `llm_not_configured`. A wrong optional variable
// (`LLM_MODEL`, `LLM_MAX_TOKENS`) is a warning of its own: the default is used and reviews run.
// Called from `src/instrumentation.ts`.
import { ALLOW_TEST_LLM_ENDPOINTS_FLAG, llmApiBaseUrl } from "./endpoint.ts";
import { readLlmDefaults, type LlmConfigIssue } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  warn?: (message: string) => void;
};

function describe(issues: readonly LlmConfigIssue[]): string {
  return issues.map((issue) => `${issue.code} (${issue.variable})`).join(", ");
}

export function checkLlmConfigOnStart({
  env = process.env,
  warn = console.warn,
}: StartOptions = {}): void {
  // A key is sent to the address of the test stack, so a deployment hears when it is switched on, and when an
  // address is named without the switch (it is ignored and the provider's own address is used).
  if (env[ALLOW_TEST_LLM_ENDPOINTS_FLAG]?.trim() === "true")
    warn(
      `[llm] LLM_TEST_ENDPOINTS_ENABLED: ${ALLOW_TEST_LLM_ENDPOINTS_FLAG} is on, so the keys of workspaces are checked at LLM_API_BASE_URL instead of the provider. Never set it in a real deployment.`,
    );
  else if (llmApiBaseUrl(env, "openrouter").overrideIgnored)
    warn(
      "[llm] LLM_API_BASE_URL_IGNORED: LLM_API_BASE_URL is set without ALLOW_TEST_LLM_ENDPOINTS=true and is ignored; keys are checked at the provider.",
    );
  const { warnings } = readLlmDefaults(env);
  if (warnings.length > 0)
    warn(
      `[llm] LLM_OPTIONS_IGNORED: ${describe(warnings)}. The default is used instead.`,
    );
}
