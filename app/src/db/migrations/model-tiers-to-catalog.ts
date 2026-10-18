// SPDX-License-Identifier: Apache-2.0

// The pure part of the migration that turns the old managed model tiers into catalog entries (#434, ADR 0005, decision
// C1; `20261018170000_migrate_model_tiers_to_catalog.ts`). No database, no clock, no secret. It does not import the tier
// code, which this issue removes: the tiers are described here once, as the data that exists in the field.
//
// The old data: the instance setting `managed_model_tiers` (`{ low?: { diff?, dynamic? }, medium?, high? }`, the model
// id behind each tier and kind), the review setting `modelTier` of a project (`projects.settings`) and of a workspace
// (`app_settings`, key `review_defaults`). The new data: catalog entries, the instance setting `catalog_defaults`, and
// `catalogEntryDiff` / `catalogEntryDynamic` in the settings of a project.
import { createHash } from "node:crypto";
import { isModelId } from "../../llm/config.ts";
import { DEFAULT_LLM_PROVIDER } from "../../llm/providers/index.ts";

export const TIERS = ["low", "medium", "high"] as const;
export type Tier = (typeof TIERS)[number];

export const KINDS = ["diff", "dynamic"] as const;
export type Kind = (typeof KINDS)[number];

/** The tier a project that chose none had: the instance default of each kind is its entry. */
const DEFAULT_TIER: Tier = "medium";

/** The same bound as the old reader (`MAX_MODEL_ID_CHARS`). */
const MAX_MODEL_ID_CHARS = 200;

const LABELS: Record<Tier, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const KIND_LABELS: Record<Kind, string> = { diff: "Diff", dynamic: "Dynamic" };

/** What the quality levels of #283 said about themselves (speed and depth only, no model, vendor or price). */
const DESCRIPTIONS: Record<Tier, string> = {
  low: "Faster, lighter reviews that point out the obvious problems quickly.",
  medium: "A balance of speed and depth that suits most pull requests.",
  high: "Slower, deeper reviews that take more time to look at a change closely.",
};

export type TierConfiguration = Partial<
  Record<Tier, Partial<Record<Kind, string>>>
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTier(value: unknown): value is Tier {
  return TIERS.some((tier) => tier === value);
}

/**
 * The stored `managed_model_tiers`, read the way the old reader did: a tier or kind that is not there, or whose model id
 * the old reader would not have accepted, is not configured. Never throws.
 */
export function readTierConfiguration(stored: unknown): TierConfiguration {
  const configuration: TierConfiguration = {};
  if (!isPlainObject(stored)) return configuration;
  for (const tier of TIERS) {
    const entry = stored[tier];
    if (!isPlainObject(entry)) continue;
    const models: Partial<Record<Kind, string>> = {};
    for (const kind of KINDS) {
      const model = entry[kind];
      if (
        typeof model === "string" &&
        model.length <= MAX_MODEL_ID_CHARS &&
        isModelId(model, DEFAULT_LLM_PROVIDER)
      )
        models[kind] = model;
    }
    if (Object.keys(models).length > 0) configuration[tier] = models;
  }
  return configuration;
}

/** A catalog entry the migration makes. Always `released`, always of the default provider. */
export type PlannedEntry = {
  /** Derived from the slug, so a second run finds the entry it made instead of making another. */
  id: string;
  tier: Tier;
  name: string;
  description: string;
  modelId: string;
  kinds: Kind[];
};

/** `mce_` and 32 hex digits, like every id of the catalog, but a function of the slug, so the same on every run. */
export function entryIdOf(slug: string): string {
  const digest = createHash("sha256")
    .update(`model-tiers-to-catalog:${slug}`)
    .digest("hex");
  return `mce_${digest.slice(0, 32)}`;
}

/**
 * The entries of a configuration, in the order Low, Medium, High. A tier whose Diff and Dynamic model are the same
 * becomes one entry serving both kinds, named like the tier; otherwise (two models, or one kind only) each kind
 * becomes an entry named `<Tier> (Diff)` or `<Tier> (Dynamic)`. The description is the one the quality level had.
 */
export function planEntries(configuration: TierConfiguration): PlannedEntry[] {
  const entries: PlannedEntry[] = [];
  for (const tier of TIERS) {
    const models = configuration[tier];
    if (models === undefined) continue;
    const description = DESCRIPTIONS[tier];
    if (models.diff !== undefined && models.diff === models.dynamic) {
      entries.push({
        id: entryIdOf(tier),
        tier,
        name: LABELS[tier],
        description,
        modelId: models.diff,
        kinds: ["diff", "dynamic"],
      });
      continue;
    }
    for (const kind of KINDS) {
      const modelId = models[kind];
      if (modelId === undefined) continue;
      entries.push({
        id: entryIdOf(`${tier}-${kind}`),
        tier,
        name: `${LABELS[tier]} (${KIND_LABELS[kind]})`,
        description,
        modelId,
        kinds: [kind],
      });
    }
  }
  return entries;
}

/** The entry of each tier and kind, from the plan. */
export type EntryIds = Partial<Record<Tier, Partial<Record<Kind, string>>>>;

export function entryIdsOf(entries: readonly PlannedEntry[]): EntryIds {
  const ids: EntryIds = {};
  for (const entry of entries)
    for (const kind of entry.kinds)
      ids[entry.tier] = { ...ids[entry.tier], [kind]: entry.id };
  return ids;
}

/** The instance default entry per kind: the medium tier's. */
export function planDefaults(
  entries: readonly PlannedEntry[],
): Record<Kind, string | null> {
  const ids = entryIdsOf(entries)[DEFAULT_TIER];
  return { diff: ids?.diff ?? null, dynamic: ids?.dynamic ?? null };
}

export type RewriteResult =
  | { kind: "unchanged" }
  | { kind: "damaged" }
  | { kind: "changed"; text: string };

/** What a stored settings text is: an object (parsed), or damaged (not JSON, or JSON that is no object). */
function parseObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

export type WorkspaceTier =
  { kind: "tier"; tier: Tier } | { kind: "none" } | { kind: "damaged" };

/** The tier of a workspace's stored review defaults, if it set one this version knows. */
export function workspaceTierOf(text: string): WorkspaceTier {
  const stored = parseObject(text);
  if (stored === undefined) return { kind: "damaged" };
  const tier = stored.modelTier;
  return isTier(tier) ? { kind: "tier", tier } : { kind: "none" };
}

const FIELD_OF_KIND = {
  diff: "catalogEntryDiff",
  dynamic: "catalogEntryDynamic",
} as const satisfies Record<Kind, string>;

/**
 * The stored settings of a project with the tier it was reviewed on turned into catalog entries. The tier is the
 * project's own `modelTier` (an explicit choice, the default tier included, stays pinned) or else the workspace's when
 * that differs from the default (the default tier is what a project without an entry gets from the instance default).
 * An entry the project already selected is kept. A kind the tier has no entry for gets none: the instance default of
 * the kind applies, as it does to any project without a choice. `modelTier` itself stays in the text, unread
 * (the old data is removed one release later). Running it on its own output changes nothing.
 */
export function rewriteSettings(
  text: string,
  context: { workspaceTier: Tier | undefined; ids: EntryIds },
): RewriteResult {
  const stored = parseObject(text);
  if (stored === undefined) return { kind: "damaged" };
  const own = isTier(stored.modelTier) ? stored.modelTier : undefined;
  const inherited =
    context.workspaceTier !== undefined &&
    context.workspaceTier !== DEFAULT_TIER
      ? context.workspaceTier
      : undefined;
  const tier = own ?? inherited;
  if (tier === undefined) return { kind: "unchanged" };

  const next: Record<string, unknown> = { ...stored };
  let changed = false;
  for (const kind of KINDS) {
    const id = context.ids[tier]?.[kind];
    const field = FIELD_OF_KIND[kind];
    const current = stored[field];
    if (id === undefined || (typeof current === "string" && current !== ""))
      continue;
    next[field] = id;
    changed = true;
  }
  return changed
    ? { kind: "changed", text: JSON.stringify(next) }
    : { kind: "unchanged" };
}
