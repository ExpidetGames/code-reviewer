// SPDX-License-Identifier: Apache-2.0

// What the provider's public model metadata says about a model (#269): does it support the tool calling
// Dynamic Review needs (`tools` and `tool_choice`), and which other capabilities does it list. OpenRouter
// answers `GET /api/v1/models/{author}/{slug}/endpoints` without a key; the answer lists the endpoints
// (providers) that serve the model, each with the request parameters it supports.
//
// - **The address is the provider's own** (src/llm/endpoint.ts), the caller passes it in; nothing a person
//   types decides where the app connects. The model name only becomes two encoded path segments.
// - **No credential, no redirect.** The request carries no `Authorization` header or cookie, does not
//   follow a redirect, has a time limit and reads a bounded number of bytes.
// - **Never throws.** A network error, a timeout, a status other than 200 and 404, an answer that is not
//   JSON, too large or of another shape is `unverifiable`: the caller decides what that means (the settings
//   save accepts it with a warning, the run-time check of the runner proxy still applies).
// - **Logs the model id and the outcome class only.** A name the settings would refuse
//   (`MODEL_NAME_PATTERN`) is checked here too: it makes no request and is logged as `(invalid)`. The error text of a failed fetch is never logged (it can name the address).
// - **A positive answer is remembered for a short time** (`createModelCapabilityChecker`), so saving the
//   same model repeatedly asks once. No other outcome is remembered: a model that gained tool support, or a
//   provider that was down, must be seen at the next try.
// - **The numbers are read at the bound a reservation needs (#279).** The endpoints a run could be routed
//   to are the ones that list `tools` and `tool_choice` and do not say they cannot force a tool choice.
//   From those the window and the output limit are the smallest stated and the unit prices the highest,
//   so a run is never held to a bound better than its worst route. A price that is not a plain decimal
//   (missing, negative, exponent form) is no price: both are `null` and the runner refuses to run the
//   model. Prices are per million tokens as exact decimal text, shifted from OpenRouter's per-token text
//   without a float.
//
// The fetch is a parameter. #279 (per-job capabilities) and #280 (managed tiers) reuse the module.
import "server-only";
import { MODEL_NAME_PATTERN } from "./config.ts";

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

export const MODEL_METADATA_TIMEOUT_MS = 5_000;
export const MODEL_METADATA_MAX_BYTES = 256 * 1024;
export const MODEL_CAPABILITY_CACHE_MS = 5 * 60 * 1000;
/**
 * How long the claim path remembers an answer that is not `supported` (#280): a provider outage then costs one wait of
 * `MODEL_METADATA_TIMEOUT_MS` per model and this time, not one per claim.
 */
export const MODEL_CAPABILITY_FAILURE_CACHE_MS = 45 * 1000;
/** How long the last context window read for a model is kept, to clamp a token budget while the provider cannot be asked. */
export const MODEL_CONTEXT_WINDOW_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_MODELS = 200;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const UNVERIFIABLE = { outcome: "unverifiable" } as const;
const UNKNOWN_MODEL = { outcome: "unknown_model" } as const;

type Endpoint = {
  parameters: readonly string[];
  maxCompletionTokens: number | null;
  contextLength: number | null;
  /** The endpoint says it cannot force a tool choice (`supports_tool_choice.required === false`). */
  cannotRequireToolChoice: boolean;
  /** Per-token prices as the provider writes them, or null when not a plain decimal text. */
  promptPrice: string | null;
  completionPrice: string | null;
};

const PER_TOKEN_PRICE = /^([0-9]{1,24})(?:\.([0-9]{1,30}))?$/;
const PRICE_SCALE_DIGITS = 6;
const MAX_PRICE_INTEGER_DIGITS = 6;
const MAX_PRICE_FRACTION_DIGITS = 18;

/**
 * A per-token price as exact US dollars per million tokens (the decimal point moved six places in the
 * text, no float), or null when it is not a plain non-negative decimal or does not fit the contract's
 * `UnitPrice`.
 */
export function pricePerMillionTokens(perToken: unknown): string | null {
  if (typeof perToken !== "string") return null;
  const match = PER_TOKEN_PRICE.exec(perToken);
  if (match === null) return null;
  const fraction = (match[2] ?? "").padEnd(PRICE_SCALE_DIGITS, "0");
  const whole = (match[1] ?? "") + fraction.slice(0, PRICE_SCALE_DIGITS);
  const rest = fraction.slice(PRICE_SCALE_DIGITS).replace(/0+$/, "");
  const integer = whole.replace(/^0+(?=[0-9])/, "");
  if (integer.length > MAX_PRICE_INTEGER_DIGITS) return null;
  if (rest.length > MAX_PRICE_FRACTION_DIGITS) return null;
  return rest === "" ? integer : `${integer}.${rest}`;
}

/** The comparable value of a text made by `pricePerMillionTokens`. */
function priceValue(text: string): bigint {
  const [integer = "0", fraction = ""] = text.split(".");
  return BigInt(integer + fraction.padEnd(MAX_PRICE_FRACTION_DIGITS, "0"));
}

/** The highest of the prices, or null if there is none or any of them is unreadable. */
function highestPrice(prices: readonly (string | null)[]): string | null {
  let highest: string | null = null;
  for (const raw of prices) {
    const price = pricePerMillionTokens(raw);
    if (price === null) return null;
    if (highest === null || priceValue(price) > priceValue(highest))
      highest = price;
  }
  return highest;
}

/** The metadata path of a model, or null for a name that cannot be an `author/slug` model. */
function metadataPath(modelId: string): string | null {
  // The module is safe on its own: a name the settings would refuse never becomes a request or a log line.
  if (!MODEL_NAME_PATTERN.test(modelId)) return null;
  // A variant (`:free`, `:nitro`, ...) is a way of routing the same model, not another model.
  const base = modelId.split(":")[0] ?? "";
  const parts = base.split("/");
  if (parts.length !== 2) return null;
  const [author, slug] = parts;
  if (author === undefined || slug === undefined) return null;
  if (author === "" || slug === "" || author === "." || author === "..")
    return null;
  if (slug === "." || slug === "..") return null;
  return `/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
}

/** The body as text, or null if it is larger than the limit (declared or streamed). */
async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MODEL_METADATA_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MODEL_METADATA_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** The endpoints of an answer, or null when it does not have the documented shape. */
function readEndpoints(parsed: unknown): Endpoint[] | null {
  if (!isRecord(parsed) || !isRecord(parsed.data)) return null;
  const list = parsed.data.endpoints;
  if (!Array.isArray(list)) return null;
  const endpoints: Endpoint[] = [];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry)) return null;
    const parameters = entry.supported_parameters;
    if (
      !Array.isArray(parameters) ||
      !parameters.every((name) => typeof name === "string")
    )
      return null;
    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    const toolChoice = isRecord(entry.supports_tool_choice)
      ? entry.supports_tool_choice
      : {};
    endpoints.push({
      parameters: parameters as string[],
      maxCompletionTokens: positiveInteger(entry.max_completion_tokens),
      contextLength: positiveInteger(entry.context_length),
      cannotRequireToolChoice: toolChoice.required === false,
      promptPrice: typeof pricing.prompt === "string" ? pricing.prompt : null,
      completionPrice:
        typeof pricing.completion === "string" ? pricing.completion : null,
    });
  }
  return endpoints;
}

function summarize(endpoints: readonly Endpoint[]): ModelCapabilityResult {
  const usable = endpoints.filter(
    (endpoint) =>
      endpoint.parameters.includes("tools") &&
      endpoint.parameters.includes("tool_choice") &&
      !endpoint.cannotRequireToolChoice,
  );
  // The capabilities of the endpoints a run could use; when none can, of all that exist.
  const read = usable.length > 0 ? usable : endpoints;
  const any = (name: string) =>
    read.some((endpoint) => endpoint.parameters.includes(name));
  const limits = read.flatMap((endpoint) =>
    endpoint.maxCompletionTokens === null ? [] : [endpoint.maxCompletionTokens],
  );
  const windows = read.map((endpoint) => endpoint.contextLength);
  const inputUsdPerMtok =
    usable.length > 0
      ? highestPrice(usable.map((endpoint) => endpoint.promptPrice))
      : null;
  const outputUsdPerMtok =
    usable.length > 0
      ? highestPrice(usable.map((endpoint) => endpoint.completionPrice))
      : null;
  // The two prices come together: a descriptor with one of them cannot price a call.
  const priced = inputUsdPerMtok !== null && outputUsdPerMtok !== null;
  return {
    outcome: usable.length > 0 ? "supported" : "unsupported",
    capabilities: {
      tools: any("tools"),
      toolChoice: any("tool_choice"),
      toolChoiceRequired: usable.length > 0,
      responseFormat: any("response_format"),
      structuredOutputs: any("structured_outputs"),
      maxCompletionTokens: limits.length > 0 ? Math.max(...limits) : null,
      smallestCompletionTokens: limits.length > 0 ? Math.min(...limits) : null,
      contextLength:
        windows.length > 0 && windows.every((window) => window !== null)
          ? Math.min(...windows)
          : null,
      inputUsdPerMtok: priced ? inputUsdPerMtok : null,
      outputUsdPerMtok: priced ? outputUsdPerMtok : null,
    },
  };
}

async function ask(
  baseUrl: string,
  path: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<ModelCapabilityResult> {
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      // No credential of any kind: the metadata is public.
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return UNKNOWN_MODEL;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return UNVERIFIABLE;
    }
    const text = await readBounded(response);
    if (text === null) return UNVERIFIABLE;
    const endpoints = readEndpoints(JSON.parse(text) as unknown);
    return endpoints === null ? UNVERIFIABLE : summarize(endpoints);
  } catch {
    // The text of a failed fetch can name the address; the class is all anyone needs.
    return UNVERIFIABLE;
  }
}

/**
 * Asks the provider's metadata whether `modelId` supports tool calling. Never throws.
 */
export async function checkModelCapabilities({
  baseUrl,
  modelId,
  fetchImpl = fetch,
  timeoutMs = MODEL_METADATA_TIMEOUT_MS,
  log = console.error,
  logAs,
}: {
  /** The provider's API address (src/llm/endpoint.ts), never a value from a request. */
  baseUrl: string;
  modelId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** What the log line names instead of the model id (the claim of a managed job names its tier, #280). */
  logAs?: string;
}): Promise<ModelCapabilityResult> {
  const path = metadataPath(modelId);
  const result =
    path === null
      ? UNKNOWN_MODEL
      : await ask(baseUrl, path, fetchImpl, timeoutMs);
  const printable =
    logAs ?? (MODEL_NAME_PATTERN.test(modelId) ? modelId : "(invalid)");
  log(
    `[llm] MODEL_CAPABILITY_CHECK: model=${printable} outcome=${result.outcome}`,
  );
  return result;
}

/** How a caller asks the checker. */
export type ModelCapabilityCheckOptions = {
  /**
   * The claim path (#280): an answer that is not `supported` is remembered for a short time, so a provider outage
   * does not stall every claim. A settings save leaves it out and always sees the provider as it is now.
   */
  forClaim?: boolean;
  /** What the log line names instead of the model id; a managed claim names its tier, which a member may know. */
  logAs?: string;
};

export type ModelCapabilityChecker = {
  check(
    modelId: string,
    options?: ModelCapabilityCheckOptions,
  ): Promise<ModelCapabilityResult>;
  /**
   * The context window the last successful read of this model stated, kept for a day (null: never read or stated
   * none). The claim clamps the token budget of a managed job to it when a fresh read fails.
   */
  lastKnownContextLength?(modelId: string): number | null;
};

/** `checkModelCapabilities` that remembers `supported` answers in memory for `ttlMs`. */
export function createModelCapabilityChecker({
  baseUrl,
  fetchImpl,
  timeoutMs,
  log,
  ttlMs = MODEL_CAPABILITY_CACHE_MS,
  failureTtlMs = MODEL_CAPABILITY_FAILURE_CACHE_MS,
  windowKeepMs = MODEL_CONTEXT_WINDOW_KEEP_MS,
  now = Date.now,
}: {
  /** Read on every ask, so a changed address (the test stack's switch) is followed. */
  baseUrl: () => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
  ttlMs?: number;
  failureTtlMs?: number;
  windowKeepMs?: number;
  now?: () => number;
}): ModelCapabilityChecker {
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
      const hit = remembered.get(modelId);
      if (hit !== undefined && hit.until > now()) return hit.result;
      remembered.delete(modelId);
      if (options.forClaim === true) {
        const failed = failures.get(modelId);
        if (failed !== undefined && failed.until > now()) return failed.result;
        failures.delete(modelId);
      }

      const result = await checkModelCapabilities({
        baseUrl: baseUrl(),
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
        put(windows, modelId, {
          until: now() + windowKeepMs,
          tokens: result.capabilities.contextLength,
        });
      if (result.outcome === "supported")
        put(remembered, modelId, { until: now() + ttlMs, result });
      else if (options.forClaim === true)
        put(failures, modelId, { until: now() + failureTtlMs, result });
      return result;
    },

    lastKnownContextLength(modelId) {
      const kept = windows.get(modelId);
      if (kept === undefined) return null;
      if (kept.until <= now()) {
        windows.delete(modelId);
        return null;
      }
      return kept.tokens;
    },
  };
}
