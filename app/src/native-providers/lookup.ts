// SPDX-License-Identifier: LicenseRef-Proprietary

// How the key of a workspace and a selection know a **catalog provider** (#555): a provider of
// `contracts/opencode-providers.v1.json` that is not one of the two of the registry. The registry (`src/llm/providers/`) is a
// closed list in code; the catalog providers are a list in data, so they cannot be in it. This is the one place that lets a
// lookup answer for both, without making any catalog provider a member of the registry: `ids` stay the registry's, so the
// cards of the two providers on the settings page, the operator's keys and the masking by name are unchanged.
//
// A catalog provider is named by its **slug** (the hyphen of the models.dev id is an underscore: `catalog-ref.ts`). Its key lives
// in the slot `llm_api_key.<slug>` of the workspace's encrypted store, bound to the slug, like the key of any provider. Pure
// and client safe: the supported file is data and nothing here reads the database or the network.
import {
  nativeProviderIdOf,
  providerSlugOf,
} from "../native-cost/catalog-ref.ts";

/** Where the key of a catalog provider lives in the store of a workspace: the prefix and then the slug. */
export const NATIVE_KEY_SECRET_PREFIX = "llm_api_key." as const;
export type NativeKeySecretName = `llm_api_key.${string}`;

export function nativeKeySecretName(slug: string): NativeKeySecretName {
  return `${NATIVE_KEY_SECRET_PREFIX}${slug}`;
}

/** What a key lookup needs of a provider: the id it is bound to and the name of its slot. */
export type KeyProvider = {
  readonly id: string;
  readonly secretNames: { readonly workspace: string };
};

/** A lookup of the providers a key can be stored for. The registry satisfies it as it is. */
export type KeyProviderLookup = {
  /** The registry's ids only: the catalog providers are not listed, they are looked up. */
  readonly ids: readonly string[];
  find(raw: unknown): KeyProvider | undefined;
};

/**
 * The catalog provider a request or a stored binding names, or undefined: trimmed and case-insensitive as the registry's
 * `find`, and only a supported one that is not a provider of `legacyProviders`.
 */
export function findNativeProvider(
  raw: unknown,
  legacyProviders: readonly string[],
): KeyProvider | undefined {
  if (typeof raw !== "string") return undefined;
  const slug = raw.trim().toLowerCase();
  if (nativeProviderIdOf(slug, legacyProviders) === null) return undefined;
  return { id: slug, secretNames: { workspace: nativeKeySecretName(slug) } };
}

/** The slug of a catalog provider id (a stored provider row), or null when no slug can spell it. */
export const slugOfCatalogProvider = providerSlugOf;

/** The lookup of a registry together with the catalog providers. The registry wins for its own ids. */
export function withNativeProviders<
  const Base extends {
    readonly ids: readonly string[];
    find(raw: unknown): KeyProvider | undefined;
  },
>(base: Base): KeyProviderLookup {
  return {
    ids: base.ids,
    find: (raw) => base.find(raw) ?? findNativeProvider(raw, base.ids),
  };
}
