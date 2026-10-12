// SPDX-License-Identifier: Apache-2.0

// What the pages may know about the instance's configuration: whether the GitHub App and the LLM access
// work and, if not, what is wrong. Only names and stable codes, never a value (the private key, the webhook
// secret and the LLM key are secrets, and a wrong value may be a secret pasted into the wrong place). Pure:
// the GitHub snapshot (src/github-config/) and the environment are passed in.
import type { GithubSnapshot } from "../github-config/credentials.ts";
import {
  findGithubAppConfigProblem,
  githubAppInstallUrl as githubAppInstallUrlOfEnv,
  githubAppInstallUrlFor,
} from "../integrations/registry.ts";
import { loadLlmConfig } from "../llm/config.ts";
import { describeLlmStatus, type LlmStatus } from "../llm/status.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GithubAppStatus =
  | { configured: true; slug: string }
  | {
      configured: false;
      /** `missing`: not set. `invalid`: set but not usable. */
      kind: "missing" | "invalid";
      /** Names of settings (`github_app_private_key`) or of environment variables, never values. */
      variables: readonly string[];
      /** The app's URL name when it is known and well formed, for the install link; otherwise null. */
      slug: string | null;
    };

export type ConfigStatus = {
  githubApp: GithubAppStatus;
  llm: LlmStatus;
};

/** The GitHub part of the status from the credentials as the server reads them. */
export function githubAppStatusOf(snapshot: GithubSnapshot): GithubAppStatus {
  if (snapshot.app.ok)
    return { configured: true, slug: snapshot.app.config.slug };
  return {
    configured: false,
    kind: snapshot.app.kind,
    variables: snapshot.app.fields,
    slug: snapshot.slug,
  };
}

/** The install address of the App (github.com/apps/<slug>/installations/new), or null while its slug is not known. */
export function installUrlOf(status: GithubAppStatus): string | null {
  return status.slug === null ? null : githubAppInstallUrlFor(status.slug);
}

/** The install address from the variables of an installation that has not been imported, or null. */
export const githubAppInstallUrl = githubAppInstallUrlOfEnv;

/**
 * The GitHub part judged from the variables alone: what the running server uses when the database holds no
 * App (an installation that has not been imported yet), and what the tests of the pages use.
 */
function githubAppStatusFromEnv(env: Env): GithubAppStatus {
  const problem = findGithubAppConfigProblem(env);
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (problem === null) return { configured: true, slug: slug as string };
  return {
    configured: false,
    kind: problem.kind,
    variables: problem.variables,
    slug: githubAppInstallUrlOfEnv(env) === null ? null : (slug as string),
  };
}

/**
 * `github` is the status the server read from the database (`githubAppStatusOf`); left out, it is judged
 * from the variables in `env`.
 */
export function describeConfigStatus(
  env: Env,
  github?: GithubAppStatus,
): ConfigStatus {
  return {
    githubApp: github ?? githubAppStatusFromEnv(env),
    llm: describeLlmStatus(loadLlmConfig(env)),
  };
}
