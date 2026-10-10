// What the server says about the LLM access when it starts. A problem is one warning with the code
// and the variable names and never stops the start: the rest of the app works without an LLM, the
// UI shows the problem and a job fails with `llm_not_configured`. Called from `src/instrumentation.ts`.
import { loadLlmConfig } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  warn?: (message: string) => void;
};

export function checkLlmConfigOnStart({
  env = process.env,
  warn = console.warn,
}: StartOptions = {}): void {
  const state = loadLlmConfig(env);
  if (state.status === "configured") return;
  const problems = state.issues
    .map((issue) => `${issue.code} (${issue.variable})`)
    .join(", ");
  warn(
    `[llm] LLM_NOT_CONFIGURED: the shared LLM access is not usable: ${problems}. Reviews cannot run until it is fixed.`,
  );
}
