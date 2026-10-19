// SPDX-License-Identifier: Apache-2.0

// The entry a job is told about its model (#548, part E): a pure function of one stored provider and one stored model.
// The result is what `contracts/job-model-entry.v1.json` describes and is checked once more against the same rules here
// before it is returned, because it decides where a real key goes and what the engine is told: the supported SDK and wire
// family from the committed file (never from models.dev), the upstream address only when it is the trusted one, the limits
// and flags of the model exactly, a status the pinned engine does not drop, and nothing else of the catalog. No key, no
// header value, no price (the ledger reads the raw usage, not the engine's cost; spike #546).
//
// A model that models.dev no longer lists is still served from here: the last known entry is the entry (maintainer
// decision of 2026-10-19). What is refused is a provider that must not carry a key: one that is not in the supported
// file, or whose address is not trusted (never safe, or changed and waiting for an admin).
import { z } from "zod";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import { supportedProvider } from "./opencode-providers.ts";
import { MODALITIES } from "./parse.ts";
import { isUsable } from "./upstream-url.ts";
import { AUTH_HEADERS, WIRE_FAMILIES } from "./wire.ts";

export const JOB_ENTRY_REFUSAL_CODES = [
  /** The provider is not in the supported file (excluded, runtime-install, or models.dev added it since). */
  "provider_unsupported",
  /** The provider's address is not trusted: refused as first seen, or changed and waiting for an admin (#554). */
  "provider_url_blocked",
  /** The model row belongs to another provider than the one given. */
  "model_not_of_provider",
  /** The stored row does not make an entry the contract allows (damaged or edited by hand). */
  "entry_invalid",
] as const;
export type JobEntryRefusalCode = (typeof JOB_ENTRY_REFUSAL_CODES)[number];

const limitSchema = z.strictObject({
  context: z.number().int().min(1).max(100_000_000),
  output: z.number().int().min(1).max(100_000_000),
  input: z.number().int().min(1).max(100_000_000).optional(),
});

const modelSchema = z.strictObject({
  name: z.string().min(1).max(120),
  status: z.enum(["active", "beta"]),
  tool_call: z.literal(true),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  limit: limitSchema,
  modalities: z.strictObject({
    input: z.array(z.enum(MODALITIES)),
    output: z.array(z.enum(MODALITIES)),
  }),
  interleaved: z
    .union([
      z.literal(true),
      z.strictObject({ field: z.string().regex(/^[a-z][a-z_]{0,39}$/) }),
    ])
    .optional(),
});

const entrySchema = z.strictObject({
  version: z.literal(1),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  npm: z.string().min(1).max(100),
  family: z.enum(WIRE_FAMILIES),
  authHeader: z.enum(AUTH_HEADERS),
  upstreamBaseUrl: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s?#@]+$/),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/),
  model: modelSchema,
});

export type JobModelEntry = z.infer<typeof entrySchema>;

export type JobEntryResult =
  { ok: true; entry: JobModelEntry } | { ok: false; code: JobEntryRefusalCode };

const refuse = (code: JobEntryRefusalCode): JobEntryResult => ({
  ok: false,
  code,
});

export function buildJobModelEntry(
  provider: StoredProvider,
  model: StoredModel,
): JobEntryResult {
  if (model.providerId !== provider.id) return refuse("model_not_of_provider");
  const supported = supportedProvider(provider.id);
  if (supported === undefined) return refuse("provider_unsupported");
  if (!isUsable(provider.url) || provider.url.trustedUrl === null)
    return refuse("provider_url_blocked");
  const parsed = entrySchema.safeParse({
    version: 1,
    providerId: provider.id,
    npm: supported.npm,
    family: supported.family,
    authHeader: supported.authHeader,
    upstreamBaseUrl: provider.url.trustedUrl,
    modelId: model.id,
    model: {
      name: model.name,
      // The pinned engine drops `deprecated` and `alpha` models and runs `beta`; the warning for the first two is
      // shown from the catalog, not by the engine.
      status: model.status === "beta" ? "beta" : "active",
      tool_call: true,
      reasoning: model.reasoning,
      temperature: model.temperature,
      limit: {
        context: model.limit.context,
        output: model.limit.output,
        ...(model.limit.input === undefined
          ? {}
          : { input: model.limit.input }),
      },
      modalities: model.modalities,
      ...(model.interleaved === null ? {} : { interleaved: model.interleaved }),
    },
  });
  return parsed.success
    ? { ok: true, entry: parsed.data }
    : refuse("entry_invalid");
}
