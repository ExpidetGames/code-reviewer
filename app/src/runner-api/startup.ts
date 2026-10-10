// A check at server start: is the runner token set and strong enough? The server starts either way
// (a deployment without a runner is valid), but every call of the runner API is refused until the
// token is fine, so the operator should hear why. The line never contains the token.
import "server-only";
import {
  MIN_RUNNER_TOKEN_LENGTH,
  configuredRunnerToken,
} from "./token-auth.ts";

/** The line to log, or null when the token is fine. */
export function runnerTokenWarning(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const token = configuredRunnerToken(env);
  if (token === undefined)
    return "[runner-api] RUNNER_TOKEN is not set: every call of the runner API is refused (401).";
  if (token.length < MIN_RUNNER_TOKEN_LENGTH)
    return `[runner-api] RUNNER_TOKEN is shorter than ${MIN_RUNNER_TOKEN_LENGTH} characters: every call of the runner API is refused (401). Create one with: openssl rand -hex 32`;
  return null;
}

export function warnAboutRunnerToken(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const line = runnerTokenWarning(env);
  if (line !== null) log(line);
}
