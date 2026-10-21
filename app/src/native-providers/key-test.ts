// SPDX-License-Identifier: Apache-2.0

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
    pinned?: readonly string[],
  ): Promise<NativeKeyOutcome>;
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
  return {
    async test(slug, apiKey, pinned = []) {
      const providerId = nativeProviderIdOf(slug, legacyProviders);
      if (providerId === null) return "unavailable";
      const provider = await models.getProvider(providerId);
      if (provider === undefined) return "unavailable";
      const built = createGenericAdapter(
        provider,
        [],
        resolveAddresses === undefined ? {} : { resolveAddresses },
      );
      if (!built.ok) return "unavailable";
      // #588: the rule of the claim. A pin that is not the address the catalog trusts now means the address moved after a project
      // selected the provider; the key is not sent to the new address, and an Owner or Admin confirms it in the project settings.
      if (pinned.some((address) => address !== provider.url.trustedUrl))
        return "address_changed";
      const check = await built.adapter.testKey({
        apiKey,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return check.outcome;
    },
  };
}
