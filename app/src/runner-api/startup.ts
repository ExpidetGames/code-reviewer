// A check at server start: is the runner token set and strong enough? The server starts either way
// (a deployment without a runner is valid), but every call of the runner API is refused until the
// token is fine, so the operator should hear why. The line never contains the token.
import "server-only";
import { runnerTokenProblem } from "./token-auth.ts";

/** The line to log, or null when the token is fine. */
export function runnerTokenWarning(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const problem = runnerTokenProblem(env);
  if (problem === null) return null;
  return `[runner-api] RUNNER_TOKEN ${problem}: every call of the runner API is refused (401). Create one with: openssl rand -hex 32`;
}

export function warnAboutRunnerToken(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const line = runnerTokenWarning(env);
  if (line !== null) log(line);
}
