// Maps an integration type to its provider. The only module (besides the providers themselves) that
// is allowed to import a provider implementation; everything else asks the registry or uses the
// IntegrationProvider interface. See README.md in this folder.
import "server-only";
import { IntegrationError } from "./errors.ts";
import type { IntegrationProvider } from "./provider.ts";
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

// The MVP has exactly one provider, the GitHub App, which arrives with its own ticket: it adds its
// entry here and nowhere else.
export const integrationRegistry = createIntegrationRegistry({});
