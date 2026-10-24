// SPDX-License-Identifier: LicenseRef-Proprietary

// What OpenRouter's public model metadata says about a model (#269): does it support the tool calling
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
// - **The numbers are read at the bound a reservation needs (#279).** The endpoints a run could be routed
//   to are the ones that list `tools` and `tool_choice` and do not say they cannot force a tool choice.
//   From those the window and the output limit are the smallest stated and the unit prices the highest,
//   so a run is never held to a bound better than its worst route. A price that is not a plain decimal
//   (missing, negative, exponent form) is no price: both are `null` and the runner refuses to run the
//   model. Prices are per million tokens as exact decimal text, shifted from OpenRouter's per-token text
//   without a float.
//
// Logging and the short-lived cache are the business of the caller (src/llm/model-capabilities.ts), which is
// the same for every provider.
import {
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_TIMEOUT_MS,
  type FetchLike,
  type LlmProviderOperations,
  type ModelCapabilityResult,
} from "../types.ts";
import { checkModelId } from "./descriptor.ts";

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
  // The adapter is safe on its own: a name the settings would refuse never becomes a request.
  if (!checkModelId(modelId)) return null;
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

export const checkModelCapabilities: LlmProviderOperations["checkModelCapabilities"] =
  async ({
    baseUrl,
    modelId,
    fetchImpl = fetch,
    timeoutMs = MODEL_METADATA_TIMEOUT_MS,
  }) => {
    const path = metadataPath(modelId);
    return path === null
      ? UNKNOWN_MODEL
      : await ask(baseUrl, path, fetchImpl, timeoutMs);
  };
