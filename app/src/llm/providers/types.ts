// SPDX-License-Identifier: Apache-2.0

// What a provider of LLM access has to bring (docs/decisions/0005-providers-model-catalog-and-paddle-billing.md,
// section 2.4). Adding a provider means adding one adapter in its own folder and listing it in the registry
// (`index.ts` for the part the browser may import, `server.ts` for the whole adapter); nothing else in the app
// names a provider.
//
// An adapter has two parts on purpose:
//
// - the **descriptor**: plain data and pure rules (name, address, secret names, the model-id rule, the models
//   to suggest and their prices, the defaults). Client components import it, so it holds nothing that talks to
//   the network and imports nothing server-only;
// - the **operations**: the two calls the server makes to the provider (`testKey`,
//   `checkModelCapabilities`). They live in the adapter and are reachable from `server.ts` only.

/** USD per million tokens of a model, as the cost guard (src/review-settings/cost.ts) needs it. */
export type ModelPrice = {
  /** USD per million input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per million output (completion) tokens. */
  outputPerMillion: number;
  /** The context window of the model, in tokens. */
  contextTokens: number;
  /** The model's tokens per token PR-Agent counts in the prompt. 1 unless measured otherwise. */
  inputTokenFactor: number;
};

/**
 * Whether the provider says what a call cost. Cost limits rely on it: a provider that reports none leaves the
 * cost of every run unknown (the policy for that comes with the first such provider).
 */
export const COST_REPORTING_VALUES = ["provider_reported", "none"] as const;
export type CostReporting = (typeof COST_REPORTING_VALUES)[number];

/** How long a key test waits for the provider. */
export const KEY_TEST_TIMEOUT_MS = 10_000;
/** How long, and how many bytes, a model-metadata read may take. */
export const MODEL_METADATA_TIMEOUT_MS = 5_000;
export const MODEL_METADATA_MAX_BYTES = 256 * 1024;

export const LLM_KEY_TEST_FAILURE_CODES = [
  /** The provider refused the key (401, 403). */
  "llm_key_rejected",
  /** Nothing answered: the address does not resolve, the connection failed, or the time ran out. */
  "llm_unreachable",
  /** Any other answer than success: a rate limit or an error of the provider's, a redirect. */
  "llm_provider_error",
] as const;
export type LlmKeyTestFailureCode = (typeof LLM_KEY_TEST_FAILURE_CODES)[number];

export type LlmKeyCheck =
  | { ok: true }
  | { ok: false; error: LlmKeyTestFailureCode; detail: string | null };

export const MODEL_CAPABILITY_OUTCOMES = [
  /** At least one endpoint lists both `tools` and `tool_choice`. */
  "supported",
  /** The model exists but no endpoint lists both. */
  "unsupported",
  /** The provider has no such model (404, or a name that cannot be one). */
  "unknown_model",
  /** The provider could not be asked or its answer could not be used. */
  "unverifiable",
] as const;
export type ModelCapabilityOutcome = (typeof MODEL_CAPABILITY_OUTCOMES)[number];

/** What the endpoints of a model list; read from the endpoints that support tools when there are any. */
export type ModelCapabilities = {
  tools: boolean;
  toolChoice: boolean;
  /** At least one endpoint lists tool calling and does not say it cannot force a tool choice. */
  toolChoiceRequired: boolean;
  responseFormat: boolean;
  structuredOutputs: boolean;
  /** The largest `max_completion_tokens` an endpoint states, or null when none states one. */
  maxCompletionTokens: number | null;
  /** The smallest `max_completion_tokens` an endpoint states, or null when none states one. */
  smallestCompletionTokens: number | null;
  /** The smallest context window of the endpoints, or null when one of them states none. */
  contextLength: number | null;
  /** US dollars per million input / output tokens, highest of the endpoints; null when unreadable. */
  inputUsdPerMtok: string | null;
  outputUsdPerMtok: string | null;
};

export type ModelCapabilityResult =
  | { outcome: "supported" | "unsupported"; capabilities: ModelCapabilities }
  | { outcome: "unknown_model" | "unverifiable" };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The part of an adapter that is data and pure rules; safe to import from a client component. */
export type LlmProviderDescriptor<Id extends string = string> = {
  /** Stable slug, `^[a-z][a-z0-9_]{1,31}$`: it is stored as the binding of a key and sent in a job. */
  readonly id: Id;
  /** The name for the copy, as the provider spells it. */
  readonly label: string;
  /** The provider's own API address. The test stack may override it (src/llm/endpoint.ts). */
  readonly apiBaseUrl: string;
  /** Where the encrypted keys live: the workspace's own key and the operator's key. Stored names never change. */
  readonly secretNames: {
    readonly workspace: string;
    readonly operator: string;
  };
  /** Whether `id` has the shape of a model id of this provider (all that is known without asking it). */
  checkModelId(id: string): boolean;
  /** Models to offer in a list. Never the only allowed ones: any model id the provider has may be chosen. */
  readonly suggestedModels: readonly string[];
  /** The price of a model, or null when the adapter does not know it (never an error). */
  priceOf(model: string): ModelPrice | null;
  /** The models used when nobody chose one, for a Diff Review and for a Dynamic Review. */
  readonly defaultModels: {
    readonly diff: string;
    readonly dynamic: string;
  };
  readonly costReporting: CostReporting;
};

/** What the server asks of a provider on the network. Both calls are given the address; neither throws. */
export type LlmProviderOperations = {
  /** Asks the provider whether `apiKey` is accepted. Never puts the key into the result. */
  testKey(input: {
    baseUrl: string;
    apiKey: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }): Promise<LlmKeyCheck>;
  /**
   * Reads the provider's public metadata about a model (no credential): does it support the tool calling
   * Dynamic Review needs, and what are its limits and prices. Everything it reads is untrusted data.
   */
  checkModelCapabilities(input: {
    baseUrl: string;
    modelId: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }): Promise<ModelCapabilityResult>;
};

export type LlmProviderAdapter<Id extends string = string> =
  LlmProviderDescriptor<Id> & LlmProviderOperations;
