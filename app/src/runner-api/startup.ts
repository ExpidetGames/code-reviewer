// SPDX-License-Identifier: Apache-2.0

// The start-up warning about the runner token: names what is wrong with RUNNER_TOKEN (not set, too
// short, or with white space or control characters inside). A production start never gets this far
// with such a token: src/deploy/startup.ts judges it by the same rule (runnerTokenProblem) and ends
// the process with DEPLOY_CONFIG_INVALID. Where that check does not run (the dev server) the server
// starts anyway, every call of the runner API is refused (401) until the token is fine, and this
// warning tells the developer why. The line never contains the token.
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
