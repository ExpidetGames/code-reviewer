// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the managed model tiers (#280, src/model-tiers/README.md). Pure: no database, no clock.
//
// A workspace on the operator's key chooses a tier, never a model. The operator configures which model backs each
// tier, per kind of review (Diff and Dynamic): that is **operator data**. Nothing in this repository names a model
// for a tier, and the ids never leave the server (the operator API and the runner's job are the two exceptions).
import { MAX_FIELD_LENGTH } from "../operator-api/contract.ts";
import { MODEL_NAME_PATTERN } from "../llm/config.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** The levels a workspace chooses from. Lower case names: the usage record carries one as `model_tier`. */
export const MODEL_TIERS = ["low", "medium", "high"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The tier of a project that chose none, at any layer. */
export const DEFAULT_MODEL_TIER: ModelTier = "medium";

export function isModelTier(value: unknown): value is ModelTier {
  return MODEL_TIERS.some((tier) => tier === value);
}

/**
 * The kinds a tier has a model for: the review kinds of a project (a test compares the lists; the review settings
 * import this file, so it only imports their types).
 */
export const TIER_REVIEW_KINDS = [
  "diff",
  "dynamic",
] as const satisfies readonly ProjectReviewKind[];

/** The model of each kind a tier has; a kind that is left out has none. Only the operator holds these. */
export type TierModels = Partial<Record<ProjectReviewKind, string>>;

/** The operator's configuration: a tier that is left out is not configured. The value of `managed_model_tiers`. */
export type ManagedModelTiers = Partial<Record<ModelTier, TierModels>>;

/** The configuration as the operator API answers: every tier and kind, null where nothing is configured. */
export type ModelTiersView = Record<
  ModelTier,
  Record<ProjectReviewKind, string | null>
>;

/** The most the rule for a model id allows (`MODEL_NAME_PATTERN` states the same bound). */
const MAX_MODEL_ID_CHARS = 200;

/**
 * `request_invalid`: not the documented shape (not an object, an unknown tier or kind, a value that is no string).
 * `model_id_invalid`: a model id the review settings would refuse too (spaces, empty, too long).
 */
export type ModelTierCheckCode = "request_invalid" | "model_id_invalid";

export type CheckTiersResult =
  | { ok: true; tiers: ManagedModelTiers }
  | { ok: false; code: ModelTierCheckCode; field?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A name that is safe to put into an answer: short and made of the characters a field name has. */
function safeName(name: string): string | undefined {
  return name.length <= MAX_FIELD_LENGTH && /^[A-Za-z0-9_.-]+$/.test(name)
    ? name
    : undefined;
}

function refused(code: ModelTierCheckCode, field?: string): CheckTiersResult {
  return field === undefined ? { ok: false, code } : { ok: false, code, field };
}

function isModelId(text: string): boolean {
  return text.length <= MAX_MODEL_ID_CHARS && MODEL_NAME_PATTERN.test(text);
}

/**
 * Checks the body of a write: `{ tiers: { <tier>: { diff?: <model id> | null, dynamic?: <model id> | null } } }`.
 * Whatever it holds replaces the stored configuration; a kind that is null or left out is not configured and a tier
 * without a model is not kept. A refusal names the place (`high.dynamic`), never the value.
 */
export function checkManagedModelTiers(input: unknown): CheckTiersResult {
  if (!isPlainObject(input)) return refused("request_invalid");
  if (Object.keys(input).length !== 1 || !("tiers" in input))
    return refused("request_invalid");
  const body = input.tiers;
  if (!isPlainObject(body)) return refused("request_invalid");

  const tiers: ManagedModelTiers = {};
  for (const [tier, entry] of Object.entries(body)) {
    if (!isModelTier(tier)) return refused("request_invalid", safeName(tier));
    if (!isPlainObject(entry)) return refused("request_invalid", tier);
    const models: TierModels = {};
    for (const [kind, raw] of Object.entries(entry)) {
      const known = TIER_REVIEW_KINDS.find((candidate) => candidate === kind);
      if (known === undefined)
        return refused("request_invalid", safeName(`${tier}.${kind}`) ?? tier);
      const place = `${tier}.${known}`;
      if (raw === null) continue;
      if (typeof raw !== "string") return refused("request_invalid", place);
      const id = raw.trim();
      if (!isModelId(id)) return refused("model_id_invalid", place);
      models[known] = id;
    }
    if (Object.keys(models).length > 0) tiers[tier] = models;
  }
  return { ok: true, tiers };
}

/**
 * The configuration as it is stored, read leniently: an entry this version would not accept is dropped (it reads as
 * not configured, and a job that needs it fails closed) instead of throwing.
 */
export function readStoredTiers(stored: unknown): ManagedModelTiers {
  const tiers: ManagedModelTiers = {};
  if (!isPlainObject(stored)) return tiers;
  for (const tier of MODEL_TIERS) {
    const entry = stored[tier];
    if (!isPlainObject(entry)) continue;
    const models: TierModels = {};
    for (const kind of TIER_REVIEW_KINDS) {
      const model = entry[kind];
      if (typeof model === "string" && isModelId(model)) models[kind] = model;
    }
    if (Object.keys(models).length > 0) tiers[tier] = models;
  }
  return tiers;
}

/** The model a tier has for a kind of review, or null (a tier is never answered by another tier's model). */
export function modelOfTier(
  tiers: ManagedModelTiers,
  tier: ModelTier,
  kind: ProjectReviewKind,
): string | null {
  return tiers[tier]?.[kind] ?? null;
}

/** Every model id the configuration holds, once each (for masking: any of them may not show in a workspace's text). */
export function allTierModels(tiers: ManagedModelTiers): string[] {
  const ids = MODEL_TIERS.flatMap((tier) =>
    TIER_REVIEW_KINDS.map((kind) => tiers[tier]?.[kind]),
  );
  return [...new Set(ids.filter((id): id is string => id !== undefined))];
}

/** What the operator API answers: the whole shape, null where nothing is configured. */
export function tiersView(tiers: ManagedModelTiers): ModelTiersView {
  const view = {} as ModelTiersView;
  for (const tier of MODEL_TIERS)
    view[tier] = {
      diff: tiers[tier]?.diff ?? null,
      dynamic: tiers[tier]?.dynamic ?? null,
    };
  return view;
}

/** Whether each tier has a model for each kind, and nothing else: all that the instance admin portal may show. */
export function configuredTiers(
  tiers: ManagedModelTiers,
): Record<ModelTier, Record<ProjectReviewKind, boolean>> {
  const view = {} as Record<ModelTier, Record<ProjectReviewKind, boolean>>;
  for (const tier of MODEL_TIERS)
    view[tier] = {
      diff: tiers[tier]?.diff !== undefined,
      dynamic: tiers[tier]?.dynamic !== undefined,
    };
  return view;
}

/** The smallest token budget a runner accepts (`MIN_LLM_CONTEXT_TOKENS`). */
const MIN_BUDGET = 1000;

/**
 * The most a managed job's token budget may be while the context window of its tier model is not known (the provider
 * cannot be asked and no earlier read is kept). It equals the built-in budget of the review settings
 * (`DEFAULT_MAX_TOKENS`), so a workspace that never changed it is unaffected, and it fits the models a tier is
 * likely to be. A workspace can set a budget up to two million; it must never reach an unknown model unclamped.
 */
export const UNKNOWN_WINDOW_MAX_TOKENS = 100_000;

/**
 * The token budget of a managed job: the workspace's budget, cut down to the context window of the tier's model when
 * the window is known (the user cannot know it: the model is not theirs to see), else to `UNKNOWN_WINDOW_MAX_TOKENS`.
 * Never below what a runner accepts.
 */
export function clampMaxTokens(
  maxTokens: number,
  contextWindow: number | null,
): number {
  const ceiling = contextWindow ?? UNKNOWN_WINDOW_MAX_TOKENS;
  if (maxTokens <= ceiling) return maxTokens;
  return Math.max(ceiling, MIN_BUDGET);
}
