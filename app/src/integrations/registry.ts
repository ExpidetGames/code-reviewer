// SPDX-License-Identifier: Apache-2.0

// Maps an integration type to its provider. The only module (besides the providers themselves) that
// is allowed to import a provider implementation; everything else asks the registry or uses the
// IntegrationProvider interface. See README.md in this folder.
import "server-only";
import { IntegrationError } from "./errors.ts";
import {
  GithubAppConfigError,
  type GithubAppConfigProblemKind,
} from "./providers/github-app/errors.ts";
import type { IntegrationProvider } from "./provider.ts";
import {
  loadGithubAppConfig,
  type GithubAppConfig,
} from "./providers/github-app/config.ts";
import { createGithubAppProvider } from "./providers/github-app/provider.ts";
import type { GithubAppClientOptions } from "./providers/github-app/client.ts";

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

// What the rest of the app may know about the GitHub App: the rest of the app reaches the provider folder
// through this file only.
export {
  githubAppInstallUrl,
  githubAppInstallUrlFor,
} from "./providers/github-app/setup-status.ts";
// Whether any GitHub App variable is set at all (the fallback of an installation that has not been imported
// yet; none is the normal state of an instance that is not connected to GitHub).
export { anyGithubAppVariableSet } from "./providers/github-app/configured.ts";
export type { GithubAppConfigProblemKind };
export { GithubAppConfigError };
export {
  loadGithubAppConfig,
  normalizePemKey,
  isUsableRsaKey,
  DEFAULT_GITHUB_API_BASE_URL,
  type GithubAppConfig,
} from "./providers/github-app/config.ts";
export {
  buildAppManifest,
  GITHUB_APP_PATHS,
  MANIFEST_PERMISSIONS,
  missingPermissions,
  suggestedAppName,
  type GithubAppManifest,
} from "./providers/github-app/manifest.ts";
export {
  checkClientCredentials,
  convertManifestCode,
  verifyGithubApp,
  type ConvertedApp,
  type ManifestConversionErrorCode,
  type VerifyAppErrorCode,
} from "./providers/github-app/app-requests.ts";

export type GithubAppConfigProblem = {
  /** `missing`: the variables are not set. `invalid`: they are set but not usable. */
  kind: GithubAppConfigProblemKind;
  /** Names of environment variables, never their values. */
  variables: readonly string[];
};

/**
 * Whether the GitHub App settings in `env` are usable, asked of the one loader the provider itself
 * uses. Returns what is wrong (the kind of problem and the variable names, never a value), or null. The
 * production start (src/deploy/startup.ts) calls it for the environment of an installation that has not
 * been imported yet.
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

export type DefaultRegistryOptions = {
  /**
   * Where the GitHub App settings are read from, on every use. Default: the database first, the process
   * environment as the fallback of an installation that has not been imported (src/github-config/).
   * Tests that have no database give the environment here, or a `loadConfig` of their own.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Reads the GitHub App settings. Overrides `env` and the default. */
  loadConfig?: () => Promise<GithubAppConfig> | GithubAppConfig;
  /** For tests: a different fetch, clock or request timeout for the GitHub client. */
  githubClient?: Omit<GithubAppClientOptions, "config">;
};

/**
 * The credentials of the GitHub App as the running server has them: the database first, the environment
 * as the fallback. A configuration that is missing or unusable fails the call that needs GitHub with
 * GITHUB_APP_CONFIG_INVALID, naming fields or variables, never values.
 */
async function loadServerGithubAppConfig(): Promise<GithubAppConfig> {
  // Imported here, not at the top: the credential store builds on this file.
  const { getGithubCredentialStore } =
    await import("../github-config/shared.ts");
  const snapshot = await getGithubCredentialStore().load();
  if (snapshot.app.ok) return snapshot.app.config;
  throw new GithubAppConfigError(snapshot.app.fields, snapshot.app.kind);
}

/**
 * The registry of this app: the GitHub App provider. The settings are read every time GitHub is used, not
 * when the app loads and not once: a missing setting fails that call with GITHUB_APP_CONFIG_INVALID and
 * breaks nothing else, and a webhook secret or key that was replaced counts from the next call.
 */
export function createDefaultIntegrationRegistry(
  options: DefaultRegistryOptions = {},
): IntegrationRegistry {
  const config =
    options.loadConfig ??
    (options.env === undefined
      ? loadServerGithubAppConfig
      : () => loadGithubAppConfig(options.env as Record<string, string>));
  return createIntegrationRegistry({
    github_app: createGithubAppProvider({
      config,
      ...(options.githubClient === undefined
        ? {}
        : { clientOptions: options.githubClient }),
    }),
  });
}

// The MVP has exactly one provider, the GitHub App. A new provider adds its entry above and nowhere
// else.
export const integrationRegistry = createDefaultIntegrationRegistry();
