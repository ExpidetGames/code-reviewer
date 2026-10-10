// What the UI may know about the GitHub App settings: whether they are complete and, if not, which
// variables are missing or not usable (names only, never a value: the private key and the webhook
// secret are secrets, and a wrong value may be a secret pasted into the wrong variable), and where
// a person installs the app. Lives in the provider folder because it reads the provider's variables;
// the rest of the app gets it through the registry (src/integrations/README.md, "The boundary").
import { createHash } from "node:crypto";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppConfigError } from "./errors.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GithubAppSetup =
  | { configured: true; slug: string }
  | {
      configured: false;
      /** `missing`: variables that are not set. `invalid`: variables that are set but not usable. */
      problem: "missing" | "invalid";
      variables: readonly string[];
      /** The app's URL name when it is set and well formed, for the install link; otherwise null. */
      slug: string | null;
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

// Checking the settings reads the key file (when the key is given as a path) and parses the RSA key,
// and three pages ask on every render. The answer is kept for a short time per set of the variables
// that matter, so a changed variable counts at once and a key file replaced under the same path is
// picked up within `CACHE_MS` (nobody waits for a restart to see the hint go away).
const RELEVANT_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_API_BASE_URL",
  "ALLOW_TEST_GITHUB_ENDPOINTS",
] as const;
export const SETUP_CACHE_MS = 30_000;

let remembered: { key: string; at: number; setup: GithubAppSetup } | undefined;

function check(env: Env): GithubAppSetup {
  try {
    return { configured: true, slug: loadGithubAppConfig(env).slug };
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

export function describeGithubAppSetup(
  env: Env,
  now: () => number = Date.now,
): GithubAppSetup {
  // Only a digest of the values is kept as the key, so a secret is not the key of anything.
  const key = createHash("sha256")
    .update(JSON.stringify(RELEVANT_VARIABLES.map((name) => env[name] ?? null)))
    .digest("hex");
  const at = now();
  if (
    remembered !== undefined &&
    remembered.key === key &&
    at - remembered.at < SETUP_CACHE_MS
  )
    return remembered.setup;
  const setup = check(env);
  remembered = { key, at, setup };
  return setup;
}

/** Forgets the remembered answer; for tests. */
export function forgetGithubAppSetup(): void {
  remembered = undefined;
}
