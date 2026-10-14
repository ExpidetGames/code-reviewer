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
  responseFormat: boolean;
  structuredOutputs: boolean;
  /** The largest `max_completion_tokens` an endpoint states, or null when none states one. */
  maxCompletionTokens: number | null;
};

export type ModelCapabilityResult =
  | { outcome: "supported" | "unsupported"; capabilities: ModelCapabilities }
  | { outcome: "unknown_model" | "unverifiable" };

export const MODEL_METADATA_TIMEOUT_MS = 5_000;
export const MODEL_METADATA_MAX_BYTES = 256 * 1024;
export const MODEL_CAPABILITY_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED_MODELS = 200;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const UNVERIFIABLE = { outcome: "unverifiable" } as const;
const UNKNOWN_MODEL = { outcome: "unknown_model" } as const;

type Endpoint = {
  parameters: readonly string[];
  maxCompletionTokens: number | null;
};

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
    const limit = entry.max_completion_tokens;
    endpoints.push({
      parameters: parameters as string[],
      maxCompletionTokens:
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? limit
          : null,
    });
  }
  return endpoints;
}

function summarize(endpoints: readonly Endpoint[]): ModelCapabilityResult {
  const usable = endpoints.filter(
    (endpoint) =>
      endpoint.parameters.includes("tools") &&
      endpoint.parameters.includes("tool_choice"),
  );
  // The capabilities of the endpoints a run could use; when none can, of all that exist.
  const read = usable.length > 0 ? usable : endpoints;
  const any = (name: string) =>
    read.some((endpoint) => endpoint.parameters.includes(name));
  const limits = read.flatMap((endpoint) =>
    endpoint.maxCompletionTokens === null ? [] : [endpoint.maxCompletionTokens],
  );
  return {
    outcome: usable.length > 0 ? "supported" : "unsupported",
    capabilities: {
      tools: any("tools"),
      toolChoice: any("tool_choice"),
      responseFormat: any("response_format"),
      structuredOutputs: any("structured_outputs"),
      maxCompletionTokens: limits.length > 0 ? Math.max(...limits) : null,
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
}: {
  /** The provider's API address (src/llm/endpoint.ts), never a value from a request. */
  baseUrl: string;
  modelId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<ModelCapabilityResult> {
  const path = metadataPath(modelId);
  const result =
    path === null
      ? UNKNOWN_MODEL
      : await ask(baseUrl, path, fetchImpl, timeoutMs);
  const printable = MODEL_NAME_PATTERN.test(modelId) ? modelId : "(invalid)";
  log(
    `[llm] MODEL_CAPABILITY_CHECK: model=${printable} outcome=${result.outcome}`,
  );
  return result;
}

export type ModelCapabilityChecker = {
  check(modelId: string): Promise<ModelCapabilityResult>;
};

/** `checkModelCapabilities` that remembers `supported` answers in memory for `ttlMs`. */
export function createModelCapabilityChecker({
  baseUrl,
  fetchImpl,
  timeoutMs,
  log,
  ttlMs = MODEL_CAPABILITY_CACHE_MS,
  now = Date.now,
}: {
  /** Read on every ask, so a changed address (the test stack's switch) is followed. */
  baseUrl: () => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (line: string) => void;
  ttlMs?: number;
  now?: () => number;
}): ModelCapabilityChecker {
  const remembered = new Map<
    string,
    { until: number; result: ModelCapabilityResult }
  >();

  return {
    async check(modelId) {
      const hit = remembered.get(modelId);
      if (hit !== undefined && hit.until > now()) return hit.result;
      remembered.delete(modelId);

      const result = await checkModelCapabilities({
        baseUrl: baseUrl(),
        modelId,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(log === undefined ? {} : { log }),
      });
      if (result.outcome !== "supported") return result;

      // Bounded: drop the oldest entries first (a Map keeps insertion order).
      while (remembered.size >= MAX_CACHED_MODELS) {
        const oldest = remembered.keys().next();
        if (oldest.done === true) break;
        remembered.delete(oldest.value);
      }
      remembered.set(modelId, { until: now() + ttlMs, result });
      return result;
    },
  };
}
