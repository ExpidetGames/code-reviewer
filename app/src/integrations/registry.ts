// Maps an integration type to its provider. The only module (besides the providers themselves) that
// is allowed to import a provider implementation; everything else asks the registry or uses the
// IntegrationProvider interface. See README.md in this folder.
import "server-only";
import { IntegrationError } from "./errors.ts";
import { createHash } from "node:crypto";
import {
  GithubAppConfigError,
  type GithubAppConfigProblemKind,
} from "./providers/github-app/errors.ts";
import type { IntegrationProvider } from "./provider.ts";
import { loadGithubAppConfig } from "./providers/github-app/config.ts";
import { createGithubAppProvider } from "./providers/github-app/provider.ts";
import type { GithubAppClientOptions } from "./providers/github-app/client.ts";

import {
  githubAppInstallUrl,
  githubAppSlug,
} from "./providers/github-app/setup-status.ts";
import {
  INTEGRATION_TYPES,
  isIntegrationType,
  isReservedIntegrationType,
  type IntegrationType,
} from "./types.ts";

export type IntegrationRegistry = {
  /** The provider for a stored or user supplied type; throws an IntegrationError with a code. */
  resolve(type: unknown): IntegrationProvider;
  registeredTypes(): IntegrationType[];
};

export function createIntegrationRegistry(
  providers: Partial<Record<IntegrationType, IntegrationProvider>>,
): IntegrationRegistry {
  for (const [key, provider] of Object.entries(providers)) {
    if (provider !== undefined && provider.type !== key)
      throw new Error(
        `Provider registered as "${key}" declares the type "${provider.type}".`,
      );
  }

  return {
    resolve(type) {
      if (isReservedIntegrationType(type))
        throw new IntegrationError(
          "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
          `The integration type "${type}" is reserved but not implemented yet.`,
        );
      if (!isIntegrationType(type))
        throw new IntegrationError(
          "INTEGRATION_TYPE_UNKNOWN",
          `Unknown integration type "${String(type)}".`,
        );
      const provider = providers[type];
      if (provider === undefined)
        throw new IntegrationError(
          "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
          `No provider is registered for the integration type "${type}".`,
        );
      return provider;
    },

    registeredTypes() {
      return INTEGRATION_TYPES.filter((type) => providers[type] !== undefined);
    },
  };
}

// What the UI may know about the GitHub App: the rest of the app reaches the provider folder through
// this file only.
export { githubAppInstallUrl };
// Whether any GitHub App variable is set at all (none is the normal state of an instance that is not
// connected to GitHub).
export { anyGithubAppVariableSet } from "./providers/github-app/configured.ts";
export type { GithubAppConfigProblemKind };

export type GithubAppConfigProblem = {
  /** `missing`: the variables are not set. `invalid`: they are set but not usable. */
  kind: GithubAppConfigProblemKind;
  /** Names of environment variables, never their values. */
  variables: readonly string[];
};

/**
 * Whether the GitHub App settings in `env` are usable, asked of the one loader the provider itself
 * uses. Returns what is wrong (the kind of problem and the variable names, never a value), or null.
 * The production start (src/deploy/startup.ts) calls it, so a bad deployment stops at once instead
 * of at the first webhook.
 */
export function findGithubAppConfigProblem(
  env: Readonly<Record<string, string | undefined>>,
): GithubAppConfigProblem | null {
  try {
    loadGithubAppConfig(env);
    return null;
  } catch (error) {
    if (!(error instanceof GithubAppConfigError)) throw error;
    return { kind: error.problem, variables: error.variables };
  }
}

export type GithubAppSetup =
  | { configured: true; slug: string }
  | ({
      configured: false;
      /** The app's URL name when it is set and well formed, for the install link; otherwise null. */
      slug: string | null;
    } & GithubAppConfigProblem);

// Checking the settings reads the key file (when the key is given as a path) and parses the RSA key,
// and three pages ask on every render. The answer is kept for a short time per set of the variables
// that matter, so a changed variable counts at once and a key file replaced under the same path is
// picked up within `SETUP_CACHE_MS` (nobody waits for a restart to see the hint go away). The start
// check (`findGithubAppConfigProblem`) is never remembered.
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

/**
 * The GitHub App settings for the pages: complete, or the kind of problem and the names of the
 * variables involved (the same answer as `findGithubAppConfigProblem`, which the start check uses),
 * plus the slug for the install link. Names only, never a value: the private key and the webhook
 * secret are secrets, and a wrong value may be a secret pasted into the wrong variable.
 */
export function describeGithubAppSetup(
  env: Readonly<Record<string, string | undefined>>,
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
  const problem = findGithubAppConfigProblem(env);
  const slug = githubAppSlug(env);
  const setup: GithubAppSetup =
    problem === null
      ? { configured: true, slug: slug as string }
      : { configured: false, ...problem, slug };
  remembered = { key, at, setup };
  return setup;
}

/** Forgets the remembered answer; for tests. */
export function forgetGithubAppSetup(): void {
  remembered = undefined;
}

export type DefaultRegistryOptions = {
  /** Where the GitHub App settings are read from, on first use. Default: the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** For tests: a different fetch, clock or request timeout for the GitHub client. */
  githubClient?: Omit<GithubAppClientOptions, "config">;
};

/**
 * The registry of this app: the GitHub App provider, configured from the environment. The settings
 * are read when GitHub is first needed, not when the app loads, so a missing variable fails that
 * call with GITHUB_APP_CONFIG_INVALID and breaks nothing else.
 */
export function createDefaultIntegrationRegistry(
  options: DefaultRegistryOptions = {},
): IntegrationRegistry {
  return createIntegrationRegistry({
    github_app: createGithubAppProvider({
      config: () => loadGithubAppConfig(options.env ?? process.env),
      ...(options.githubClient === undefined
        ? {}
        : { clientOptions: options.githubClient }),
    }),
  });
}

// The MVP has exactly one provider, the GitHub App. A new provider adds its entry above and nowhere
// else.
export const integrationRegistry = createDefaultIntegrationRegistry();
