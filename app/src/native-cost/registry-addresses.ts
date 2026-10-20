// SPDX-License-Identifier: Apache-2.0

// Where the key of a registry provider may be sent (#578, hardening after the security review of PR #580).
//
// The two providers of the app's registry keep their API addresses in their descriptors (`apiBaseUrl`); the runner pins the same
// addresses (`llm_providers.py`). The catalog's address for such a provider is trusted data (trust on first use, `models-dev/
// upstream-url.ts`) but not the registry's own, so a claim whose entry for one of them names another address is refused here, with
// a stable code, before any key exists. A provider the registry has no address for is not judged by this module: its address stays
// under the rules of the catalog (https, a public host, a change blocks it until an admin accepts it).
import "server-only";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { catalogProviderIdOf } from "./catalog-ref.ts";
import { legacyProvidersFor } from "./switch.ts";

/** The refusal of an entry whose address is not the registry's. Stable: the claim logs it as `entry_upstream_not_registry`. */
export const UPSTREAM_NOT_REGISTRY = "upstream_not_registry";

/** The API addresses of the registry's providers, by the provider id of the catalog (the underscore of a slug is its hyphen). */
export function registryAddressesOf(
  providers: readonly { id: string; apiBaseUrl: string }[],
): Readonly<Record<string, string>> {
  const addresses: Record<string, string> = {};
  for (const provider of providers) {
    const id = catalogProviderIdOf(provider.id);
    if (id !== null) addresses[id] = provider.apiBaseUrl;
  }
  return addresses;
}

/** Whether two addresses are the same one. A trailing slash is the only difference tolerated, as in the runner. */
export function sameAddress(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

/**
 * What the running server tells the native cost service about the app's registry: the providers that keep their wire (all of
 * them while the switch is off, none once it is on) and the addresses that are pinned whatever the switch says.
 */
export function nativeCostRegistryFor(
  environment: Readonly<Record<string, string | undefined>>,
): {
  legacyProviders: readonly string[];
  registryAddresses: Readonly<Record<string, string>>;
} {
  return {
    legacyProviders: legacyProvidersFor(
      environment,
      llmProviderDescriptors.ids,
    ),
    registryAddresses: registryAddressesOf(llmProviderDescriptors.providers),
  };
}
