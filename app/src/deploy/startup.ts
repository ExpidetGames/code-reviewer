// What the production server checks about the deployment when it starts, besides sign in (see
// src/auth/startup.ts): the shared token of the runner and the credentials of the GitHub App. A
// missing value would otherwise show up later as a failing runner or webhook with a less helpful
// message. Called from `src/instrumentation.ts`. A problem is reported with variable names only,
// never with a value (they are secrets).

export const DEPLOY_ERROR_CODES = ["DEPLOY_CONFIG_INVALID"] as const;
export type DeployErrorCode = (typeof DEPLOY_ERROR_CODES)[number];

const MIN_RUNNER_TOKEN_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

type StartOptions = {
  env?: Env;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

function has(env: Env, name: string): boolean {
  return (env[name]?.trim() ?? "") !== "";
}

/** The problems of the deployment settings, each naming only the variables concerned. */
export function findDeploymentConfigProblems(env: Env): string[] {
  const problems: string[] = [];

  if (!has(env, "RUNNER_TOKEN")) problems.push("RUNNER_TOKEN is not set");
  else if ((env.RUNNER_TOKEN?.trim().length ?? 0) < MIN_RUNNER_TOKEN_LENGTH)
    problems.push(
      `RUNNER_TOKEN must be at least ${String(MIN_RUNNER_TOKEN_LENGTH)} characters long`,
    );

  // Written out one by one on purpose: src/ci/compose.test.ts finds the variable names the code
  // reads by their literal use and checks that .env.example documents each of them.
  if (!has(env, "GITHUB_APP_ID")) problems.push("GITHUB_APP_ID is not set");
  if (!has(env, "GITHUB_APP_SLUG")) problems.push("GITHUB_APP_SLUG is not set");
  if (!has(env, "GITHUB_APP_WEBHOOK_SECRET"))
    problems.push("GITHUB_APP_WEBHOOK_SECRET is not set");
  if (
    !has(env, "GITHUB_APP_PRIVATE_KEY") &&
    !has(env, "GITHUB_APP_PRIVATE_KEY_PATH")
  )
    problems.push(
      "GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH) is not set",
    );

  return problems;
}

/**
 * In production, an incomplete deployment configuration ends the process with exit code 1 and one
 * readable line (the error code and the variable names), not a stack trace. Other environments
 * (the dev server) are not checked, so the sign in can be tried without a GitHub App.
 */
export function checkDeploymentConfigOnStart({
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
}: StartOptions = {}): void {
  if (env.NODE_ENV !== "production") return;
  const problems = findDeploymentConfigProblems(env);
  if (problems.length === 0) return;
  log(
    `[deploy] DEPLOY_CONFIG_INVALID: The deployment configuration is incomplete or invalid: ${problems.join("; ")}.`,
  );
  exit(1);
}
