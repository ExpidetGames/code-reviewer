// SPDX-License-Identifier: LicenseRef-Proprietary

// The key test of a catalog provider (#555): the "test key" button for a provider that has no adapter of its own. It uses the
// generic adapter built from the catalog row (`src/models-dev/generic-adapter.ts`): one cheap authenticated read of the
// provider's model list at its **trusted** address, never a redirect, through the connect guard. The answer is a class, never a
// word the provider said (it may repeat the key). "Not verified" is an answer: not every provider has a model list to ask.
import "server-only";
import type { ModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { AddressResolver } from "../models-dev/connect-guard.ts";
import type { FetchLike } from "../models-dev/fetch.ts";
import {
  createGenericAdapter,
  type GenericKeyOutcome,
} from "../models-dev/generic-adapter.ts";
import { nativeProviderIdOf } from "../native-cost/catalog-ref.ts";

export type NativeKeyOutcome =
  | GenericKeyOutcome
  | "unavailable"
  /** A project of the workspace pinned another address than the catalog trusts now (#588): nothing was sent. */
  | "address_changed";

export type NativeKeyTester = {
  /**
   * Asks the provider of this slug whether the key is accepted. `unavailable`: nothing was sent (not a usable provider).
   * `pinned` (#588) are the addresses the workspace's projects pinned for the provider; the key goes to the trusted address only
   * when every one of them is that address, as a claim holds to it (`address_changed`: nothing was sent).
   */
  test(
    slug: string,
    apiKey: string,
    pinned: readonly string[],
  ): Promise<NativeKeyOutcome>;
  /**
   * Whether the pins hold, asked before a stored key is decrypted (#588): true when the provider is not one that would be asked, or
   * when every pin is the address the catalog trusts now. `test` makes the same judgement again before it sends anything.
   */
  addressHolds(slug: string, pinned: readonly string[]): Promise<boolean>;
};

export function createNativeKeyTester({
  models,
  legacyProviders,
  fetchImpl,
  resolveAddresses,
  timeoutMs,
}: {
  models: Pick<ModelsDevRepository, "getProvider">;
  legacyProviders: readonly string[];
  /** Only a test passes this; left out, the request goes through the connect guard. */
  fetchImpl?: FetchLike;
  resolveAddresses?: AddressResolver;
  timeoutMs?: number;
}): NativeKeyTester {
  /** The provider of this slug as the test would ask it, or undefined when nothing would be sent. */
  async function usable(slug: string) {
    const providerId = nativeProviderIdOf(slug, legacyProviders);
    if (providerId === null) return undefined;
    const provider = await models.getProvider(providerId);
    if (provider === undefined) return undefined;
    const built = createGenericAdapter(
      provider,
      [],
      resolveAddresses === undefined ? {} : { resolveAddresses },
    );
    return built.ok ? { provider, adapter: built.adapter } : undefined;
  }

  /** #588: the rule of the claim. A pin that is not the address the catalog trusts now means the address moved after a project selected the provider. */
  const holds = (trusted: string | null, pinned: readonly string[]) =>
    pinned.every((address) => address === trusted);

  return {
    async test(slug, apiKey, pinned) {
      const found = await usable(slug);
      if (found === undefined) return "unavailable";
      // The key is not sent to the new address; an Owner or Admin confirms it in the project settings.
      if (!holds(found.provider.url.trustedUrl, pinned))
        return "address_changed";
      const check = await found.adapter.testKey({
        apiKey,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return check.outcome;
    },

    async addressHolds(slug, pinned) {
      const found = await usable(slug);
      return (
        found === undefined || holds(found.provider.url.trustedUrl, pinned)
      );
    },
  };
}
