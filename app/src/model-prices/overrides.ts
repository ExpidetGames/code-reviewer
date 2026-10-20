// SPDX-License-Identifier: Apache-2.0

// The override file (#549, part A): `contracts/model-overrides.v1.json`, a short committed list of the fields models.dev
// lacks or gets wrong in a way that is a code matter. Per provider and model: the price of a 1-hour cache write
// (models.dev has none), a date after which the model is never offered, a block (never offered), each with a one-line
// reason. Nothing else belongs in it. It is validated when the app starts to read it (an unknown field, a negative or
// inexact price, a missing reason or a provider that is not supported fails), and edited by a normal pull request. The
// app image holds `app/` only, so it reads its identical copy, `./model-overrides.v1.json`; a test compares the two.
// Data only; no server code.
import { z } from "zod";
import { supportedProvider } from "../models-dev/opencode-providers.ts";
import raw from "./model-overrides.v1.json" with { type: "json" };
import { usdPerMTokToMicroUsd } from "./money.ts";

const MAX_REASON_LENGTH = 200;

function isCalendarDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

const entrySchema = z
  .strictObject({
    reason: z
      .string()
      .min(1)
      .max(MAX_REASON_LENGTH)
      .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u),
    cacheWrite1hPerMTok: z
      .string()
      .transform((value) => usdPerMTokToMicroUsd(value))
      .refine((value) => value !== null)
      .optional(),
    retiresNotBefore: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => isCalendarDate(value))
      .optional(),
    // Only `true` is a statement; a block that is not one would be an entry that says nothing.
    blocked: z.literal(true).optional(),
  })
  .refine(
    (entry) =>
      entry.cacheWrite1hPerMTok !== undefined ||
      entry.retiresNotBefore !== undefined ||
      entry.blocked !== undefined,
  )
  .transform((entry) => ({
    reason: entry.reason,
    cacheWrite1h: entry.cacheWrite1hPerMTok ?? null,
    retiresNotBefore: entry.retiresNotBefore ?? null,
    blocked: entry.blocked === true,
  }));

const providerSchema = z.strictObject({
  models: z.record(z.string().min(1).max(200), entrySchema),
});

const fileSchema = z.strictObject({
  $comment: z.string().optional(),
  version: z.literal(1),
  providers: z
    .record(z.string(), providerSchema)
    .refine((providers) =>
      Object.keys(providers).every((id) => supportedProvider(id) !== undefined),
    ),
});

/** What the file says about one model. Prices are micro-USD per million tokens. */
export type ModelOverride = {
  reason: string;
  /** The price of a cache write with the 1-hour lifetime; null when the file states none. */
  cacheWrite1h: bigint | null;
  /** The model is never offered from this day on (UTC), as `YYYY-MM-DD`; null when it has no date. */
  retiresNotBefore: string | null;
  blocked: boolean;
};
export type ModelOverrides = {
  version: 1;
  providers: Record<string, { models: Record<string, ModelOverride> }>;
};

export type OverridesParse =
  { ok: true; overrides: ModelOverrides } | { ok: false };

export function parseModelOverrides(input: unknown): OverridesParse {
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const { version, providers } = parsed.data;
  return { ok: true, overrides: { version, providers } as ModelOverrides };
}

const loaded = parseModelOverrides(raw);
if (!loaded.ok)
  throw new Error(
    "model-overrides.v1.json is not valid: see overrides.test.ts for the rules.",
  );
export const MODEL_OVERRIDES: ModelOverrides = loaded.overrides;

/** The override of a model, or undefined when the file does not name it. */
export function modelOverride(
  providerId: string,
  modelId: string,
): ModelOverride | undefined {
  if (!Object.hasOwn(MODEL_OVERRIDES.providers, providerId)) return undefined;
  const models = MODEL_OVERRIDES.providers[providerId]?.models;
  if (models === undefined || !Object.hasOwn(models, modelId)) return undefined;
  return models[modelId];
}
