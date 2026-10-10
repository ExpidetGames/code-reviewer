// What the pages may know about the instance's configuration: whether the GitHub App settings and
// the LLM access work and, if not, which variables are wrong. Only names and stable codes, never a
// value (the private key, the webhook secret and the LLM key are secrets, and a wrong value may be a
// secret pasted into the wrong variable). Pure: the environment is passed in.
import { loadLlmConfig } from "../llm/config.ts";
import { describeLlmStatus, type LlmStatus } from "../llm/status.ts";
import { GithubAppConfigError } from "../integrations/providers/github-app/errors.ts";
import { loadGithubAppConfig } from "../integrations/providers/github-app/config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GithubAppStatus =
  | { configured: true; slug: string }
  | {
      configured: false;
      /** `missing`: variables that are not set. `invalid`: variables that are set but not usable. */
      problem: "missing" | "invalid";
      variables: readonly string[];
      /** The app's URL name when it is set and well formed, for the install link; otherwise null. */
      slug: string | null;
    };

export type ConfigStatus = {
  githubApp: GithubAppStatus;
  llm: LlmStatus;
};

// The same rule as the provider's configuration (GITHUB_APP_SLUG), so a slug used for a link is
// always one the app itself would accept.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function slugOf(env: Env): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim();
  return slug !== undefined && SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Where a person installs the GitHub App (github.com/apps/<slug>/installations/new), or null while
 * the slug is not set. It always points at github.com: the test endpoints only replace the API.
 */
export function githubAppInstallUrl(env: Env): string | null {
  const slug = slugOf(env);
  return slug === null
    ? null
    : `https://github.com/apps/${slug}/installations/new`;
}

function describeGithubApp(env: Env): GithubAppStatus {
  try {
    const config = loadGithubAppConfig(env);
    return { configured: true, slug: config.slug };
  } catch (error) {
    if (!(error instanceof GithubAppConfigError)) throw error;
    return {
      configured: false,
      problem: error.problem,
      variables: error.variables,
      slug: slugOf(env),
    };
  }
}

export function describeConfigStatus(env: Env): ConfigStatus {
  return {
    githubApp: describeGithubApp(env),
    llm: describeLlmStatus(loadLlmConfig(env)),
  };
}
