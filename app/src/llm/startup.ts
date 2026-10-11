// SPDX-License-Identifier: Apache-2.0

// What the server says about the LLM access when it starts. A problem is one warning with the code
// and the variable names and never stops the start: the rest of the app works without an LLM, the
// UI shows the problem and a job fails with `llm_not_configured`. A wrong optional variable
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
  if (state.status === "misconfigured")
    warn(
      `[llm] LLM_NOT_CONFIGURED: the shared LLM access is not usable: ${describe(state.issues)}. Reviews cannot run until it is fixed.`,
    );
  if (state.warnings.length > 0)
    warn(
      `[llm] LLM_OPTIONS_IGNORED: ${describe(state.warnings)}. The default is used instead.`,
    );
}
