// SPDX-License-Identifier: LicenseRef-Proprietary

// The "test key" button of the LLM access settings (docs/decisions/0001-editions-setup-and-accounts.md, issue
// #104): one cheap call to the provider that says whether the key is accepted, and the class of the failure when
// it is not (`llm_key_rejected`, `llm_unreachable`, `llm_provider_error`) with a sentence that is safe to show.
// The call itself is the provider's adapter (src/llm/providers/: the address, what to ask, how an answer is
// read and cleaned); what is the same for every provider is here:
//
// - **Limited** per workspace and for the whole instance, counted in the shared `rate_limits` table; counters
//   that cannot be read refuse the click (the caller answers 503), they never wave it through.
//   The instance budget is shared by everybody: the workspaces of one person can use it up, and the button is then
//   refused for all of them for a while (nothing else is affected).
// - The key is absent from the log line, and nothing the provider said is passed on as it is (the adapter).
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { NativeKeyTester } from "../native-providers/key-test.ts";
import { nativeProviderIdOf } from "../native-cost/catalog-ref.ts";
import type { LlmProvider } from "./config.ts";
import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "./providers/index.ts";
import { llmProviderAdapters } from "./providers/server.ts";
import type { LlmProviderAdapter } from "./providers/types.ts";
import {
  KEY_TEST_TIMEOUT_MS,
  LLM_KEY_TEST_FAILURE_CODES,
  type FetchLike,
  type LlmKeyCheck,
  type LlmKeyTestFailureCode,
} from "./providers/types.ts";

/** The adapters the key test reads: the server's registry, or a test's own. */
type Adapters = { get(id: LlmProvider): Pick<LlmProviderAdapter, "testKey"> };

export { KEY_TEST_TIMEOUT_MS, LLM_KEY_TEST_FAILURE_CODES };
export type { LlmKeyCheck, LlmKeyTestFailureCode };

/**
 * Asks the provider whether `apiKey` is accepted, through its adapter. Never throws; never puts the key (or
 * anything the provider echoed of it) into the result.
 */
export function checkLlmKey({
  baseUrl,
  apiKey,
  provider = DEFAULT_LLM_PROVIDER,
  fetchImpl,
  timeoutMs,
  adapters = llmProviderAdapters,
}: {
  /** The provider's API address (src/llm/endpoint.ts), never a value from a request. */
  baseUrl: string;
  apiKey: string;
  provider?: LlmProvider;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** The providers the app supports; a test passes its own. */
  adapters?: Adapters;
}): Promise<LlmKeyCheck> {
  return adapters.get(provider).testKey({
    baseUrl,
    apiKey,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

export const KEY_TEST_WORKSPACE_MAX = 5;
export const KEY_TEST_GLOBAL_MAX = 60;
export const KEY_TEST_WINDOW_MS = 10 * 60 * 1000;

export function keyTestWorkspaceKey(workspaceId: string): string {
  return `llm-key-test:workspace:${workspaceId}`;
}
export const KEY_TEST_GLOBAL_KEY = "llm-key-test:all";

export type LlmKeyTestResult =
  | LlmKeyCheck
  /** The provider has no way to check a key (#555): not an error, and not a verified key either. */
  | { ok: true; verified: false }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

/** The answer of a key test whose catalog provider moved its address after a project of the workspace selected it (#588). */
const ADDRESS_CHANGED = {
  ok: false,
  error: "llm_provider_address_changed",
  detail: null,
} as const satisfies LlmKeyTestResult;

export type LlmKeyTestService = {
  /**
   * What to answer before the key is needed (#588): the failure when the provider is a catalog provider and a project of the
   * workspace pinned another address than the catalog trusts now, else null. A caller asks it before it decrypts a stored key, so a
   * key whose test would be refused is not read for nothing. Counts against no allowance.
   */
  preflight(input: {
    workspaceId: string;
    provider: LlmProvider | string;
  }): Promise<LlmKeyTestResult | null>;
  /** Tests the key (the caller has chosen which one: the typed one or the stored one). */
  test(input: {
    workspaceId: string;
    /** A provider of the registry, or (with `native` given) a catalog provider's slug (#555). */
    provider: LlmProvider | string;
    apiKey: string;
  }): Promise<LlmKeyTestResult>;
};

export function createLlmKeyTestService({
  rateLimits,
  baseUrlOf,
  fetchImpl,
  timeoutMs,
  adapters,
  native,
  pinnedAddresses,
  now = () => new Date(),
  log = console.error,
}: {
  rateLimits: RateLimitsRepository;
  /** The provider's API address; the real one, or the fake in the test stack (src/llm/endpoint.ts). */
  baseUrlOf: (provider: LlmProvider) => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** The providers the app supports; a test passes its own. */
  adapters?: Adapters;
  /** The key test of a catalog provider (#555); left out, a provider outside the registry is a provider error. */
  native?: NativeKeyTester;
  /**
   * The addresses the workspace's projects that use a catalog provider pinned for it (#588); the test of that provider is held to
   * them as a claim is. Required: a test that has no pins says so with an empty list, so the running server cannot leave it out.
   */
  pinnedAddresses: (
    workspaceId: string,
    slug: string,
  ) => Promise<readonly string[]>;
  now?: () => Date;
  log?: (line: string) => void;
}): LlmKeyTestService {
  const isCatalogProvider = (provider: string) =>
    native !== undefined &&
    nativeProviderIdOf(provider, llmProviderDescriptors.ids) !== null;

  return {
    async preflight({ workspaceId, provider }) {
      if (native === undefined || !isCatalogProvider(provider)) return null;
      const pinned = await pinnedAddresses(workspaceId, provider);
      if (await native.addressHolds(provider, pinned)) return null;
      log(`[llm] KEY_TEST_FAILED: ${ADDRESS_CHANGED.error}`);
      return ADDRESS_CHANGED;
    },

    async test({ workspaceId, provider, apiKey }) {
      const limited = (hit: { windowStartedAt: Date }) =>
        ({
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: secondsLeft(
            hit.windowStartedAt,
            KEY_TEST_WINDOW_MS,
            now(),
          ),
        }) as const;
      // The counter of the instance first: a workspace over its own allowance must not use up the budget of the
      // instance (its attempt is taken back), and an instance out of budget counts against no workspace.
      const instance = await rateLimits.hit(
        KEY_TEST_GLOBAL_KEY,
        KEY_TEST_WINDOW_MS,
      );
      if (instance.count > KEY_TEST_GLOBAL_MAX) return limited(instance);
      const own = await rateLimits.hit(
        keyTestWorkspaceKey(workspaceId),
        KEY_TEST_WINDOW_MS,
      );
      if (own.count > KEY_TEST_WORKSPACE_MAX) {
        await rateLimits.refund(KEY_TEST_GLOBAL_KEY);
        return limited(own);
      }

      const result =
        native !== undefined && isCatalogProvider(provider)
          ? await testCatalogKey(
              native,
              provider,
              apiKey,
              await pinnedAddresses(workspaceId, provider),
            )
          : await checkLlmKey({
              baseUrl: baseUrlOf(provider as LlmProvider),
              apiKey,
              provider: provider as LlmProvider,
              ...(fetchImpl === undefined ? {} : { fetchImpl }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(adapters === undefined ? {} : { adapters }),
            });
      if (!result.ok) log(`[llm] KEY_TEST_FAILED: ${result.error}`);
      return result;
    },
  };
}

/** The answer of a catalog provider's key test as the button shows it. Never carries a word the provider said. */
async function testCatalogKey(
  native: NativeKeyTester,
  slug: string,
  apiKey: string,
  pinned: readonly string[],
): Promise<LlmKeyTestResult> {
  switch (await native.test(slug, apiKey, pinned)) {
    case "accepted":
      return { ok: true };
    case "not_verified":
      return { ok: true, verified: false };
    case "rejected":
      return { ok: false, error: "llm_key_rejected", detail: null };
    case "unreachable":
      return { ok: false, error: "llm_unreachable", detail: null };
    case "address_changed":
      return ADDRESS_CHANGED;
    case "provider_error":
    case "unavailable":
      return { ok: false, error: "llm_provider_error", detail: null };
  }
}
