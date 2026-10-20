// SPDX-License-Identifier: Apache-2.0

// Reads a models.dev body (#548, part A). Everything in it is untrusted data (AGENTS.md): the body is parsed by a strict
// but tolerant schema (a field it does not know is ignored, a model that does not fit is skipped and counted, never half
// written), every string is length-capped and stored as text only, and only what a job needs is kept. A provider that is
// not in the supported file (`opencode-providers.ts`) is not even looked into, and a model without `tool_call: true` is
// never kept (the pinned OpenCode does not enforce the flag, so the catalog must, #546). Pure: no network, no database.
import { z } from "zod";
import { excludedReason, supportedProvider } from "./opencode-providers.ts";
import { INTERLEAVED_FIELDS, type InterleavedField } from "./wire.ts";

export const MAX_NAME_LENGTH = 120;
/** The longest address kept; a longer one is flagged and judged as invalid by the address check. */
export const MAX_API_LENGTH = 2048;
const MAX_FAMILY_LENGTH = 80;
/**
 * The most models one provider may state. The largest supported provider has 621 (nano-gpt, 2026-10-19; 405 with tool
 * calling) and the whole catalog 6,558 models with tool calling, so this is more than three times the largest today and
 * still small enough that one poisoned provider cannot make a body expensive to read or a table large. A provider above it
 * is not read (its models are not even parsed) and counted; the guard then refuses the fetch (`plan.ts`).
 */
export const MAX_MODELS_PER_PROVIDER = 2000;
/** The largest limit models.dev states (`99999999` stands for "no limit"). */
const MAX_LIMIT = 100_000_000;
/** USD per million tokens; far above any real price, so a typo cannot become a charge. */
const MAX_PRICE = 100_000;
/**
 * The most tiers of one price that are stored. Real models have one to three; a body above this is flagged (`unknown`), so
 * that a poisoned model cannot make a row large and a model with more tiers than we hold is never priced from a cut list.
 */
export const MAX_COST_TIERS = 64;
/** The most names listed in `ModelCost.unknown`. */
const MAX_UNKNOWN_NAMES = 16;

export const MODELS_DEV_STATUSES = [
  "alpha",
  "beta",
  "deprecated",
  "active",
] as const;
export type ModelsDevStatus = (typeof MODELS_DEV_STATUSES)[number];
export const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
export type Modality = (typeof MODALITIES)[number];

/** The prices of one level (the base price, a tier or the older `context_over_200k`) as models.dev names them, camel-cased. */
export type CostAmounts = {
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
  reasoning?: string;
  inputAudio?: string;
  outputAudio?: string;
};

export type PriceTier = CostAmounts & {
  /** The tier applies to a prompt above this many tokens. */
  contextOver: number;
};

/**
 * USD per million tokens as exact decimal strings (no float rounding enters a price). Everything models.dev states about a
 * price is kept, so that a change to any of it is seen: the price of reasoning tokens, audio, the older
 * `context_over_200k` and every tier, in the order models.dev lists them.
 */
export type ModelCost = CostAmounts & {
  contextOver200k?: CostAmounts;
  tiers?: PriceTier[];
  /**
   * Names of what the price states and we cannot read: a price field or a tier of a kind we do not know, a malformed tier,
   * more tiers than we hold. Sorted, plain names only (`cost.input_video`, `tier_type.time_of_day`, `tier`). A model that
   * has any is not priced for the managed key (`price-book.ts`): we cannot bill what we do not understand. Absent when empty.
   */
  unknown?: string[];
};

export type Interleaved = true | { field: InterleavedField };

export type ReducedModel = {
  providerId: string;
  id: string;
  name: string;
  family: string | null;
  limit: { context: number; output: number; input?: number };
  reasoning: boolean;
  temperature: boolean;
  attachment: boolean;
  modalities: { input: Modality[]; output: Modality[] };
  status: ModelsDevStatus | null;
  cost: ModelCost | null;
  lastUpdated: string | null;
  interleaved: Interleaved | null;
};

export type ReducedProvider = {
  id: string;
  name: string;
  /** The address models.dev states, cut to `MAX_API_LENGTH`; null when it states none. Judged by `upstream-url.ts`. */
  api: string | null;
  apiTooLong: boolean;
};

export type SkipCounts = {
  /** A provider or a model that does not fit the schema. */
  invalid: number;
  noToolCalling: number;
  /** An embedding, image, video, speech or rerank model: not a model that answers a prompt. */
  notLanguageModel: number;
  /** A model with a `provider` of its own (another SDK or address), which would change the wire or where the key goes. */
  modelProviderOverride: number;
  /** A provider the supported file lists as excluded. */
  unsupportedProviders: number;
  /** A provider the supported file does not know (models.dev added it after the file was derived). */
  unknownProviders: number;
  /** A supported provider that states more than `MAX_MODELS_PER_PROVIDER` models; none of its models is read. */
  oversizedProviders: number;
};

export type ParsedModelsDev = {
  ok: true;
  providers: ReducedProvider[];
  models: ReducedModel[];
  skipped: SkipCounts;
};
export type ParseFailure = { ok: false; code: "models_dev_invalid_body" };

/**
 * Printable text, one line, at most `max` characters (by code point, so that the cut never splits a pair). Control
 * characters, line breaks and the invisible format characters (zero width, right-to-left override) become a space.
 */
function text(max: number) {
  return z
    .string()
    .transform((value) =>
      value
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/ {2,}/g, " ")
        .trim(),
    )
    .transform((value) => Array.from(value).slice(0, max).join(""))
    .pipe(z.string().min(1));
}

const count = z.number().int().min(1).max(MAX_LIMIT);
const price = z.number().min(0).max(MAX_PRICE);

// The base price is validated as before (a bad input, output or cache price makes the model invalid); everything else it
// states is read by `amountsOf`, so that a key we do not know is seen and not lost.
const costSchema = z
  .object({
    input: price,
    output: price,
    cache_read: price.optional(),
    cache_write: price.optional(),
    tiers: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

const modelSchema = z.object({
  id: z.string().optional(),
  name: text(MAX_NAME_LENGTH),
  family: text(MAX_FAMILY_LENGTH).optional().catch(undefined),
  reasoning: z.boolean().optional(),
  temperature: z.boolean().optional(),
  attachment: z.boolean().optional(),
  limit: z.object({
    context: count,
    output: count,
    input: count.optional().catch(undefined),
  }),
  modalities: z
    .object({
      input: z.array(z.unknown()).optional(),
      output: z.array(z.unknown()).optional(),
    })
    .optional()
    .catch(undefined),
  status: z.enum(MODELS_DEV_STATUSES).optional(),
  cost: costSchema.optional(),
  last_updated: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/)
    .optional()
    .catch(undefined),
  interleaved: z.unknown().optional(),
});

/** What a runner accepts as a model id (runner/README.md, "llm"), plus the `@region` suffix some providers use. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/;

function decimal(value: number): string {
  const plain = String(value);
  if (!plain.includes("e")) return plain;
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

const AMOUNT_FIELDS = {
  input: "input",
  output: "output",
  cache_read: "cacheRead",
  cache_write: "cacheWrite",
  reasoning: "reasoning",
  input_audio: "inputAudio",
  output_audio: "outputAudio",
} as const satisfies Record<string, keyof CostAmounts>;
type AmountKey = keyof typeof AMOUNT_FIELDS;

const isAmountKey = (key: string): key is AmountKey =>
  Object.hasOwn(AMOUNT_FIELDS, key);

/** A name from the body as it may appear in a stored list: short and plain, never the body's own text. */
function plainName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(name)
    ? name
    : "invalid_name";
}

/** The prices a level states, and the names of what in it is not a price we know. `skip` are keys read elsewhere. */
function amountsOf(
  level: Record<string, unknown>,
  skip: readonly string[],
  scope: string,
): { amounts: Partial<Record<keyof CostAmounts, string>>; unknown: string[] } {
  const amounts: Partial<Record<keyof CostAmounts, string>> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(level)) {
    if (skip.includes(key)) continue;
    const parsed = isAmountKey(key) ? price.safeParse(value) : undefined;
    if (!isAmountKey(key) || parsed === undefined || !parsed.success)
      unknown.push(`${scope}.${plainName(key)}`);
    else amounts[AMOUNT_FIELDS[key]] = decimal(parsed.data);
  }
  return { amounts, unknown };
}

/** A level that states an input and an output price, or undefined (and the names of what was wrong). */
function levelOf(
  value: unknown,
  skip: readonly string[],
  scope: string,
): { level: CostAmounts | undefined; unknown: string[] } {
  if (!isRecord(value)) return { level: undefined, unknown: [scope] };
  const { amounts, unknown } = amountsOf(value, skip, scope);
  const { input, output, ...rest } = amounts;
  if (input === undefined || output === undefined)
    return { level: undefined, unknown: [...unknown, scope] };
  return { level: { input, output, ...rest }, unknown };
}

function tierOf(candidate: unknown): {
  tier: PriceTier | undefined;
  unknown: string[];
} {
  if (!isRecord(candidate)) return { tier: undefined, unknown: ["tier"] };
  const kind = candidate.tier;
  if (!isRecord(kind)) return { tier: undefined, unknown: ["tier"] };
  // A tier of a kind we do not know (by time of day, by region, ...) never replaces the base price, and the model is not
  // priced: its real price may be that one.
  if (kind.type !== "context")
    return {
      tier: undefined,
      unknown: [`tier_type.${plainName(kind.type)}`],
    };
  const size = count.safeParse(kind.size);
  const { level, unknown } = levelOf(candidate, ["tier"], "tier");
  if (!size.success || level === undefined)
    return { tier: undefined, unknown: [...unknown, "tier"] };
  return { tier: { contextOver: size.data, ...level }, unknown };
}

function costOf(parsed: z.infer<typeof costSchema>): ModelCost {
  const { tiers: candidates = [], cache_read, cache_write, ...stated } = parsed;
  const { input, output, context_over_200k, ...others } = stated;
  const { amounts, unknown } = amountsOf(others, [], "cost");
  const names = new Set(unknown);
  const cost: ModelCost = {
    ...amounts,
    input: decimal(input),
    output: decimal(output),
  };
  if (cache_read !== undefined) cost.cacheRead = decimal(cache_read);
  if (cache_write !== undefined) cost.cacheWrite = decimal(cache_write);
  if (context_over_200k !== undefined) {
    const older = levelOf(context_over_200k, [], "context_over_200k");
    if (older.level !== undefined) cost.contextOver200k = older.level;
    for (const name of older.unknown) names.add(name);
  }
  const tiers: PriceTier[] = [];
  if (candidates.length > MAX_COST_TIERS) names.add("tiers_over_limit");
  for (const candidate of candidates.slice(0, MAX_COST_TIERS)) {
    const read = tierOf(candidate);
    if (read.tier !== undefined) tiers.push(read.tier);
    for (const name of read.unknown) names.add(name);
  }
  if (tiers.length > 0) cost.tiers = tiers;
  if (names.size > 0)
    cost.unknown = [...names].sort().slice(0, MAX_UNKNOWN_NAMES);
  return cost;
}

/** The modalities it knows, once each, in the order of `MODALITIES` (the order the stored row reads back in). */
function modalitiesOf(values: unknown[] | undefined): Modality[] {
  return MODALITIES.filter((modality) => values?.includes(modality) === true);
}

function interleavedOf(value: unknown): Interleaved | null {
  if (value === true) return true;
  const field =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "field" in value
        ? (value as { field: unknown }).field
        : undefined;
  // Only the names the pinned engine is known to hand the reasoning back in (wire.ts); another name is dropped.
  return INTERLEAVED_FIELDS.find((known) => known === field) === undefined
    ? null
    : { field: field as InterleavedField };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ModelOutcome =
  | { kind: "model"; model: ReducedModel }
  | { kind: "skip"; reason: keyof SkipCounts };

function modelOf(
  providerId: string,
  key: string,
  candidate: unknown,
): ModelOutcome {
  if (!MODEL_ID.test(key) || !isRecord(candidate))
    return { kind: "skip", reason: "invalid" };
  // The flags that decide what a model is come first: an embedding model has a limit of zero and no price shape to
  // speak of, and is not an invalid body, only not a model we use.
  if (candidate.tool_call !== true)
    return { kind: "skip", reason: "noToolCalling" };
  if (candidate.type !== undefined)
    return { kind: "skip", reason: "notLanguageModel" };
  if (candidate.provider !== undefined)
    return { kind: "skip", reason: "modelProviderOverride" };
  const parsed = modelSchema.safeParse(candidate);
  if (!parsed.success) return { kind: "skip", reason: "invalid" };
  const model = parsed.data;
  if (model.id !== undefined && model.id !== key)
    return { kind: "skip", reason: "invalid" };
  return {
    kind: "model",
    model: {
      providerId,
      id: key,
      name: model.name,
      family: model.family ?? null,
      limit: {
        context: model.limit.context,
        output: model.limit.output,
        ...(model.limit.input === undefined
          ? {}
          : { input: model.limit.input }),
      },
      reasoning: model.reasoning === true,
      temperature: model.temperature === true,
      attachment: model.attachment === true,
      modalities: {
        input: modalitiesOf(model.modalities?.input),
        output: modalitiesOf(model.modalities?.output),
      },
      status: model.status ?? null,
      cost: model.cost === undefined ? null : costOf(model.cost),
      lastUpdated: model.last_updated ?? null,
      interleaved: interleavedOf(model.interleaved),
    },
  };
}

const providerSchema = z.object({
  name: text(MAX_NAME_LENGTH),
  api: z.unknown().optional(),
  models: z.record(z.string(), z.unknown()),
});

/**
 * The providers and models a job can use, from a parsed models.dev body. Fails (stable code, nothing to apply) when the
 * body is not an object of providers or holds not one usable model of a supported provider: a body like that is an error
 * page or an upstream that changed shape, and applying it would unlist the whole catalog.
 */
export function parseModelsDev(body: unknown): ParsedModelsDev | ParseFailure {
  if (!isRecord(body)) return { ok: false, code: "models_dev_invalid_body" };
  const providers: ReducedProvider[] = [];
  const models: ReducedModel[] = [];
  const skipped: SkipCounts = {
    invalid: 0,
    noToolCalling: 0,
    notLanguageModel: 0,
    modelProviderOverride: 0,
    unsupportedProviders: 0,
    unknownProviders: 0,
    oversizedProviders: 0,
  };
  for (const [providerId, candidate] of Object.entries(body)) {
    if (supportedProvider(providerId) === undefined) {
      if (excludedReason(providerId) === undefined)
        skipped.unknownProviders += 1;
      else skipped.unsupportedProviders += 1;
      continue;
    }
    const provider = providerSchema.safeParse(candidate);
    if (!provider.success) {
      skipped.invalid += 1;
      continue;
    }
    const entries = Object.entries(provider.data.models);
    if (entries.length > MAX_MODELS_PER_PROVIDER) {
      skipped.oversizedProviders += 1;
      continue;
    }
    const kept: ReducedModel[] = [];
    for (const [key, model] of entries) {
      const outcome = modelOf(providerId, key, model);
      if (outcome.kind === "model") kept.push(outcome.model);
      else skipped[outcome.reason] += 1;
    }
    if (kept.length === 0) continue;
    const api =
      typeof provider.data.api === "string" ? provider.data.api : null;
    providers.push({
      id: providerId,
      name: provider.data.name,
      api: api === null ? null : api.slice(0, MAX_API_LENGTH),
      apiTooLong: api !== null && api.length > MAX_API_LENGTH,
    });
    models.push(...kept);
  }
  if (models.length === 0)
    return { ok: false, code: "models_dev_invalid_body" };
  return { ok: true, providers, models, skipped };
}
