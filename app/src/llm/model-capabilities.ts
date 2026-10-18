// SPDX-License-Identifier: Apache-2.0

// What the provider's public model metadata says about a model (#269): does it support the tool calling
// Dynamic Review needs (`tools` and `tool_choice`), and which other capabilities does it list. The question
// itself, and how an answer is read, is the provider's adapter (src/llm/providers/); what is the same for every
// provider is here:
//
// - **Never throws.** A network error, a timeout, a status other than 200 and 404, an answer that is not
//   JSON, too large or of another shape is `unverifiable`: the caller decides what that means (the settings
//   save accepts it with a warning, the run-time check of the runner proxy still applies).
// - **Logs the model id and the outcome class only.** A name the provider's model-id rule refuses makes no
//   request and is logged as `(invalid)`. The error text of a failed fetch is never logged (it can name the
//   address).
// - **A positive answer is remembered for a short time** (`createModelCapabilityChecker`), so saving the
//   same model repeatedly asks once. No other outcome is remembered: a model that gained tool support, or a
//   provider that was down, must be seen at the next try. The memory is keyed by provider and model: the same
//   name at two providers is two models.
//
// The fetch is a parameter. #279 (per-job capabilities) and #280 (managed tiers) reuse the module.
import "server-only";
import type { LlmProvider } from "./config.ts";
import { DEFAULT_LLM_PROVIDER } from "./providers/index.ts";
import { llmProviderAdapters } from "./providers/server.ts";
import {
  MODEL_CAPABILITY_OUTCOMES,
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_TIMEOUT_MS,
  type FetchLike,
  type LlmProviderAdapter,
  type ModelCapabilities,
  type ModelCapabilityOutcome,
  type ModelCapabilityResult,
} from "./providers/types.ts";

export {
  MODEL_CAPABILITY_OUTCOMES,
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_TIMEOUT_MS,
};
export type {
  ModelCapabilities,
  ModelCapabilityOutcome,
  ModelCapabilityResult,
};

export const MODEL_CAPABILITY_CACHE_MS = 5 * 60 * 1000;
/**
 * How long the claim path remembers an answer that is not `supported` (#280): a provider outage then costs one wait of
 * `MODEL_METADATA_TIMEOUT_MS` per model and this time, not one per claim.
 */
export const MODEL_CAPABILITY_FAILURE_CACHE_MS = 45 * 1000;
/** How long the last context window read for a model is kept, to clamp a token budget while the provider cannot be asked. */
export const MODEL_CONTEXT_WINDOW_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_MODELS = 200;

/**
 * Where the checker finds the adapter of a provider: the registry of the app, or one a test builds with a second
 * provider. `get` throws for an id it does not know. `P` is the type of a provider id.
 */
export type AdapterLookup<P extends string = LlmProvider> = {
  get(id: P): LlmProviderAdapter;
};

/** The memory is per provider and model; a provider id has no NUL, so the two parts cannot run together. */
const cacheKey = (provider: string, modelId: string) =>
  `${provider}\0${modelId}`;

/**
 * Asks the provider's metadata whether `modelId` supports tool calling. Never throws.
 */
export function checkModelCapabilities({
  provider = DEFAULT_LLM_PROVIDER,
  ...input
}: {
  /** The provider's API address (src/llm/endpoint.ts), never a value from a request. */
  baseUrl: string;
  modelId: string;
  /** The provider the model belongs to; the default provider until a project can choose. */
  provider?: LlmProvider;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** What the log line names instead of the model id (the claim of a managed job names its catalog entry, #432). */
  logAs?: string;
}): Promise<ModelCapabilityResult> {
  return askAdapter(llmProviderAdapters.get(provider), input);
}

async function askAdapter(
  adapter: LlmProviderAdapter,
  {
    baseUrl,
    modelId,
    fetchImpl,
    timeoutMs,
    log = console.error,
    logAs,
  }: {
    baseUrl: string;
    modelId: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    log?: (line: string) => void;
    logAs?: string;
  },
): Promise<ModelCapabilityResult> {
  const result = await adapter.checkModelCapabilities({
    baseUrl,
    modelId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const printable =
    logAs ?? (adapter.checkModelId(modelId) ? modelId : "(invalid)");
  log(
    `[llm] MODEL_CAPABILITY_CHECK: model=${printable} outcome=${result.outcome}`,
  );
  return result;
}

/** How a caller asks the checker. */
export type ModelCapabilityCheckOptions<P extends string = LlmProvider> = {
  /**
   * The claim path (#280): an answer that is not `supported` is remembered for a short time, so a provider outage
   * does not stall every claim. A settings save leaves it out and always sees the provider as it is now.
   */
  forClaim?: boolean;
  /** What the log line names instead of the model id; a managed claim names its entry id, which a member may know. */
  logAs?: string;
  /** The provider the model belongs to; the default provider when left out. */
  provider?: P;
};

export type ModelCapabilityChecker<P extends string = LlmProvider> = {
  check(
    modelId: string,
    options?: ModelCapabilityCheckOptions<P>,
  ): Promise<ModelCapabilityResult>;
  /**
   * The context window the last successful read of this model stated, kept for a day (null: never read or stated
   * none). The claim clamps the token budget of a managed job to it when a fresh read fails.
   */
  lastKnownContextLength?(modelId: string, provider?: P): number | null;
};

/** `checkModelCapabilities` that remembers `supported` answers in memory for `ttlMs`. */
export function createModelCapabilityChecker<P extends string = LlmProvider>({
  adapters = llmProviderAdapters as unknown as AdapterLookup<P>, // `P` is `LlmProvider` when no lookup is given
  baseUrl,
  fetchImpl,
  timeoutMs,
  log,
  ttlMs = MODEL_CAPABILITY_CACHE_MS,
  failureTtlMs = MODEL_CAPABILITY_FAILURE_CACHE_MS,
  windowKeepMs = MODEL_CONTEXT_WINDOW_KEEP_MS,
  now = Date.now,
}: {
  /** The adapters to ask; the app's registry unless a test brings its own. */
  adapters?: AdapterLookup<P>;
  /** Read on every ask, so a changed address (the test stack's switch) is followed. */
  baseUrl: (provider: P) => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
  ttlMs?: number;
  failureTtlMs?: number;
  windowKeepMs?: number;
  now?: () => number;
}): ModelCapabilityChecker<P> {
  type Entry = { until: number; result: ModelCapabilityResult };
  const remembered = new Map<string, Entry>();
  const failures = new Map<string, Entry>();
  const windows = new Map<string, { until: number; tokens: number }>();

  /** Bounded: drop the oldest entries first (a Map keeps insertion order). */
  function put<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    while (map.size >= MAX_CACHED_MODELS) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
    }
    map.set(key, value);
  }

  return {
    async check(modelId, options = {}) {
      const provider = options.provider ?? (DEFAULT_LLM_PROVIDER as P);
      const key = cacheKey(provider, modelId);
      const hit = remembered.get(key);
      if (hit !== undefined && hit.until > now()) return hit.result;
      remembered.delete(key);
      if (options.forClaim === true) {
        const failed = failures.get(key);
        if (failed !== undefined && failed.until > now()) return failed.result;
        failures.delete(key);
      }

      const result = await askAdapter(adapters.get(provider), {
        baseUrl: baseUrl(provider),
        modelId,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(log === undefined ? {} : { log }),
        ...(options.logAs === undefined ? {} : { logAs: options.logAs }),
      });
      if (
        "capabilities" in result &&
        result.capabilities.contextLength !== null
      )
        put(windows, key, {
          until: now() + windowKeepMs,
          tokens: result.capabilities.contextLength,
        });
      if (result.outcome === "supported")
        put(remembered, key, { until: now() + ttlMs, result });
      else if (options.forClaim === true)
        put(failures, key, { until: now() + failureTtlMs, result });
      return result;
    },

    lastKnownContextLength(modelId, provider = DEFAULT_LLM_PROVIDER as P) {
      const key = cacheKey(provider, modelId);
      const kept = windows.get(key);
      if (kept === undefined) return null;
      if (kept.until <= now()) {
        windows.delete(key);
        return null;
      }
      return kept.tokens;
    },
  };
}
