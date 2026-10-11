// What the production server checks about the deployment when it starts, besides sign in (see
// src/auth/startup.ts, which requires the master key and the public address): the shared token of the
// runner. A missing value would otherwise show up later as a failing runner with a less helpful
// message. Called from `src/instrumentation.ts`.
//
// The GitHub App is not required any more: an instance starts without any `GITHUB_*` variable and
// GitHub is then "not configured" (the pages say so) until the integration is set up. Settings that
// are there but incomplete or unusable are reported as a warning, by variable name only, never with
// a value (they are secrets), judged by the same loader the provider uses
// (src/integrations/providers/github-app/config.ts, reached through the registry).

import { runnerTokenProblem } from "../runner-api/token-auth.ts";

export const DEPLOY_ERROR_CODES = ["DEPLOY_CONFIG_INVALID"] as const;
export type DeployErrorCode = (typeof DEPLOY_ERROR_CODES)[number];

type Env = Readonly<Record<string, string | undefined>>;

type StartOptions = {
  env?: Env;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
};

/** The problems of the deployment settings, each naming only the variables concerned. */
export function findDeploymentConfigProblems(env: Env): string[] {
  const problems: string[] = [];

  // The token is judged by the runner API's own rule, the one that also logs the start-up warning.
  const tokenProblem = runnerTokenProblem(env);
  if (tokenProblem !== null) problems.push(`RUNNER_TOKEN ${tokenProblem}`);

  return problems;
}

/**
 * A warning line when some GitHub App variable is set but the settings are not usable, or null when
 * none is set (GitHub is simply not configured) or all are fine. Names variables, never values.
 */
export async function githubAppConfigWarning(env: Env): Promise<string | null> {
  // Imported here, not at the top: only a production start needs the provider code.
  const { anyGithubAppVariableSet, findGithubAppConfigProblem } =
    await import("../integrations/registry.ts");
  if (!anyGithubAppVariableSet(env)) return null;
  const problem = findGithubAppConfigProblem(env);
  if (problem === null) return null;
  return `[deploy] GITHUB_APP_CONFIG_INVALID: The GitHub App settings are ${problem.kind}: ${problem.variables.join(", ")}. GitHub stays not configured until they are fixed; the instance starts without it.`;
}

/**
 * In production, an incomplete deployment configuration (the runner token) ends the process with
 * exit code 1 and one readable line (the error code and the variable names), not a stack trace. Other
 * environments (the dev server) are not checked. An unusable GitHub App configuration only warns.
 */
export async function checkDeploymentConfigOnStart({
  env = process.env,
  log = console.error,
  warn = console.warn,
  exit = (code) => process.exit(code),
}: StartOptions = {}): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const problems = findDeploymentConfigProblems(env);
  if (problems.length > 0) {
    log(
      `[deploy] ${DEPLOY_ERROR_CODES[0]}: The deployment configuration is incomplete or invalid: ${problems.join("; ")}.`,
    );
    exit(1);
    return;
  }
  const githubWarning = await githubAppConfigWarning(env);
  if (githubWarning !== null) warn(githubWarning);
}
