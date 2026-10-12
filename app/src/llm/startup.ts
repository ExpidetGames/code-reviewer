// SPDX-License-Identifier: Apache-2.0

// What the server says about the LLM access when it starts. The LLM key is a matter of each workspace now
// (src/llm/resolve.ts), so an instance without `LLM_*` variables is normal and says nothing. What is reported is a
// legacy variable that is SET BUT WRONG, and an optional one that is ignored. A problem is one warning with the
// code and the variable names and never stops the start: the rest of the app works without an LLM, the UI shows
// the problem and a job fails with `llm_not_configured`. A wrong optional variable
// (`LLM_MODEL`, `LLM_MAX_TOKENS`) is a warning of its own: the default is used and reviews run.
// Called from `src/instrumentation.ts`.
import { loadLlmConfig, type LlmConfigIssue } from "./config.ts";

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
  const state = loadLlmConfig(env);
  // Nothing set at all is the normal state of an instance whose workspaces bring their own key.
  const wrong =
    state.status === "misconfigured"
      ? state.issues.filter(
          (issue) =>
            issue.code !== "LLM_API_KEY_MISSING" &&
            issue.code !== "LLM_PROVIDER_MISSING",
        )
      : [];
  if (state.status === "misconfigured" && wrong.length > 0)
    warn(
      `[llm] LLM_NOT_CONFIGURED: the shared LLM access from the environment is not usable: ${describe(wrong)}. Workspaces with a key of their own are not affected.`,
    );
  if (state.warnings.length > 0)
    warn(
      `[llm] LLM_OPTIONS_IGNORED: ${describe(state.warnings)}. The default is used instead.`,
    );
}
