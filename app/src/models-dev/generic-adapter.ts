// SPDX-License-Identifier: Apache-2.0

// The generic provider adapter (#548, part D, #423): any provider of the supported file resolves to an adapter built from
// the catalog rows, not from code per provider: the descriptor (id, name, wire family, key header, address), the model
// list and a best-effort key test. It is the data half of what the registry of `src/llm/providers/` asks of an adapter;
// putting it into that registry is a step for the workspace picker (#555), because the registry's ids and secret names are
// slugs (`^[a-z][a-z0-9_]{1,31}$`) and these providers' ids are models.dev's (with hyphens). The two hand-written
// adapters keep their place until #556.
//
// The key test is a cheap authenticated read: the provider's model list. "Not verified" is an answer, not a failure,
// because not every provider has one. It goes to the trusted address of the provider only, never follows a redirect (that
// would carry the key elsewhere), and returns a class, never a word the provider said (it may repeat the key). The key
// leaves this server, so the connection itself is guarded (`connect-guard.ts`): the name is resolved again at the
// connection, a name that now resolves to a private address gets no key, and the connect goes to the address that was
// checked.
import "server-only";
import type { ModelPrice } from "../llm/providers/types.ts";
import { KEY_TEST_TIMEOUT_MS } from "../llm/providers/types.ts";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import {
  createGuardedFetch,
  createGuardedLookup,
  type AddressResolver,
} from "./connect-guard.ts";
import type { FetchLike } from "./fetch.ts";
import { supportedProvider } from "./opencode-providers.ts";
import { isUsable } from "./upstream-url.ts";
import type { AuthHeader, WireFamily } from "./wire.ts";

export type GenericKeyOutcome =
  "accepted" | "rejected" | "not_verified" | "unreachable" | "provider_error";

export type GenericKeyCheck = { outcome: GenericKeyOutcome };

export type GenericAdapterModel = {
  id: string;
  name: string;
  contextTokens: number;
  outputTokens: number;
  reasoning: boolean;
  /** models.dev no longer lists it; the last known entry is kept and the model still works. */
  unlisted: boolean;
  /** models.dev marks it `deprecated`: shown as a warning. */
  deprecated: boolean;
};

export type GenericProviderAdapter = {
  id: string;
  label: string;
  npm: string;
  family: WireFamily;
  authHeader: AuthHeader;
  /** The trusted address of the provider: where a real key is sent. */
  baseUrl: string;
  models: readonly GenericAdapterModel[];
  checkModelId(id: string): boolean;
  /** The catalog's price of a model, or null when it has none (an unpriced model is an unknown cost, never zero). */
  priceOf(model: string): ModelPrice | null;
  testKey(input: {
    apiKey: string;
    /** Left out, the request is made by the connect guard. A test passes its own. */
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }): Promise<GenericKeyCheck>;
};

export type GenericAdapterResult =
  | { ok: true; adapter: GenericProviderAdapter }
  | { ok: false; code: "provider_unsupported" | "provider_url_blocked" };

function headersOf(
  family: WireFamily,
  header: AuthHeader,
  apiKey: string,
): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (header === "Authorization") base.authorization = `Bearer ${apiKey}`;
  else base[header] = apiKey;
  if (family === "anthropic-messages") base["anthropic-version"] = "2023-06-01";
  return base;
}

function outcomeOfStatus(code: number): GenericKeyOutcome {
  if (code >= 200 && code < 300) return "accepted";
  if (code === 401 || code === 403) return "rejected";
  // No such route: the provider has no model list to ask, which says nothing about the key.
  if (code === 404 || code === 405 || code === 501) return "not_verified";
  if (code >= 500) return "unreachable";
  return "provider_error";
}

export type GenericAdapterOptions = {
  /** How the guarded connection resolves a name; the real DNS when left out. */
  resolveAddresses?: AddressResolver;
};

export function createGenericAdapter(
  provider: StoredProvider,
  models: readonly StoredModel[],
  options: GenericAdapterOptions = {},
): GenericAdapterResult {
  const supported = supportedProvider(provider.id);
  if (supported === undefined)
    return { ok: false, code: "provider_unsupported" };
  const baseUrl = provider.url.trustedUrl;
  if (!isUsable(provider.url) || baseUrl === null)
    return { ok: false, code: "provider_url_blocked" };
  const own = models.filter((model) => model.providerId === provider.id);
  const byId = new Map(own.map((model) => [model.id, model]));
  return {
    ok: true,
    adapter: {
      id: provider.id,
      label: provider.name,
      npm: supported.npm,
      family: supported.family,
      authHeader: supported.authHeader,
      baseUrl,
      models: own.map((model) => ({
        id: model.id,
        name: model.name,
        contextTokens: model.limit.context,
        outputTokens: model.limit.output,
        reasoning: model.reasoning,
        unlisted: model.unlistedAt !== null,
        deprecated: model.status === "deprecated",
      })),
      checkModelId: (id) => byId.has(id),
      priceOf(id) {
        const model = byId.get(id);
        if (model?.cost == null) return null;
        return {
          inputPerMillion: Number(model.cost.input),
          outputPerMillion: Number(model.cost.output),
          contextTokens: model.limit.context,
          inputTokenFactor: 1,
        };
      },
      async testKey({
        apiKey,
        fetchImpl = createGuardedFetch({
          lookup: createGuardedLookup(options.resolveAddresses),
        }),
        timeoutMs = KEY_TEST_TIMEOUT_MS,
      }) {
        try {
          const response = await fetchImpl(`${baseUrl}/models`, {
            method: "GET",
            headers: headersOf(supported.family, supported.authHeader, apiKey),
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          await response.body?.cancel().catch(() => undefined);
          return { outcome: outcomeOfStatus(response.status) };
        } catch {
          // The text of a failed fetch can name the address and the key; the class is all there is.
          return { outcome: "unreachable" };
        }
      },
    },
  };
}
