// SPDX-License-Identifier: Apache-2.0

// What the production server checks about the deployment when it starts, besides sign in (see
// src/auth/startup.ts, which requires the master key and the public address): the shared token of the
// runner. A missing value would otherwise show up later as a failing runner with a less helpful
// message. Called from `src/instrumentation.ts`.
//
// The GitHub App is not an environment setting any more: it is entered in the admin portal, and the variables of
// an installation from before accounts are imported once (src/legacy-import/), which also says which of them
// could not be used. An instance starts without any `GITHUB_*` variable; GitHub is then "not configured" (the
// pages say so) until the integration is set up.

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
export function findDeploymentConfigProblems(env: Env): string[] {
  const problems: string[] = [];

  // The token is judged by the runner API's own rule, the one that also logs the start-up warning.
  const tokenProblem = runnerTokenProblem(env);
  if (tokenProblem !== null) problems.push(`RUNNER_TOKEN ${tokenProblem}`);

  return problems;
}

/**
 * In production, an incomplete deployment configuration (the runner token) ends the process with
 * exit code 1 and one readable line (the error code and the variable names), not a stack trace. Other
 * environments (the dev server) are not checked.
 */
export async function checkDeploymentConfigOnStart({
  env = process.env,
  log = console.error,
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
}
