// Maps an integration type to its provider. The only module (besides the providers themselves) that
// is allowed to import a provider implementation; everything else asks the registry or uses the
// IntegrationProvider interface. See README.md in this folder.
import "server-only";
import { IntegrationError } from "./errors.ts";
import { GithubAppConfigError } from "./providers/github-app/errors.ts";
import type { IntegrationProvider } from "./provider.ts";
import { loadGithubAppConfig } from "./providers/github-app/config.ts";
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

/**
 * Whether the GitHub App settings in `env` are usable, asked of the one loader the provider itself
 * uses. Returns a sentence naming the missing or invalid variables (never their values), or null.
 * The production start (src/deploy/startup.ts) calls it, so a bad deployment stops at once instead
 * of at the first webhook.
 */
export function findGithubAppConfigProblem(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  try {
    loadGithubAppConfig(env);
    return null;
  } catch (error) {
    if (!(error instanceof GithubAppConfigError)) throw error;
    return error.message.replace(/\.$/, "");
  }
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
