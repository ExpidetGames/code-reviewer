// What the production server checks about the deployment when it starts, besides sign in (see
// src/auth/startup.ts): the shared token of the runner and the credentials of the GitHub App. A
// missing value would otherwise show up later as a failing runner or webhook with a less helpful
// message. Called from `src/instrumentation.ts`. The GitHub App part is judged by the same loader
// the provider uses (src/integrations/providers/github-app/config.ts, reached through the registry),
// so the two cannot disagree. A problem is reported with variable names only, never with a value (they are secrets).

import { runnerTokenProblem } from "../runner-api/token-auth.ts";

export const DEPLOY_ERROR_CODES = ["DEPLOY_CONFIG_INVALID"] as const;
export type DeployErrorCode = (typeof DEPLOY_ERROR_CODES)[number];

type Env = Readonly<Record<string, string | undefined>>;

type StartOptions = {
  env?: Env;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

/** The problems of the deployment settings, each naming only the variables concerned. */
export async function findDeploymentConfigProblems(
  env: Env,
): Promise<string[]> {
  const problems: string[] = [];

  // The token is judged by the runner API's own rule, the one that also logs the start-up warning.
  const tokenProblem = runnerTokenProblem(env);
  if (tokenProblem !== null) problems.push(`RUNNER_TOKEN ${tokenProblem}`);

  // The GitHub App settings have exactly one reader, the provider's loader; this check only asks it
  // whether the settings are usable (it names variables, never values).
  // Imported here, not at the top: only a production start needs the provider code.
  const { findGithubAppConfigProblem } =
    await import("../integrations/registry.ts");
  const githubApp = findGithubAppConfigProblem(env);
  if (githubApp !== null)
    problems.push(
      `GitHub App settings ${githubApp.kind}: ${githubApp.variables.join(", ")}`,
    );

  return problems;
}

/**
 * In production, an incomplete deployment configuration ends the process with exit code 1 and one
 * readable line (the error code and the variable names), not a stack trace. Other environments
 * (the dev server) are not checked, so the sign in can be tried without a GitHub App.
 */
export async function checkDeploymentConfigOnStart({
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
}: StartOptions = {}): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const problems = await findDeploymentConfigProblems(env);
  if (problems.length === 0) return;
  log(
    `[deploy] ${DEPLOY_ERROR_CODES[0]}: The deployment configuration is incomplete or invalid: ${problems.join("; ")}.`,
  );
  exit(1);
}
