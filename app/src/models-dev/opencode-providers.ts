// SPDX-License-Identifier: LicenseRef-Proprietary

// The providers of models.dev that the pinned OpenCode can drive with a static key and a bundled SDK
// (`contracts/opencode-providers.v1.json`, derived by src/ci/opencode-providers/ and tied to `runner/opencode-pin.json`).
// The app image holds `app/` only, so it reads its identical copy, `./opencode-providers.v1.json`. Only a provider in this
// file is ever stored (#548, part B); one that models.dev adds later is unknown and ignored until the file is derived again.
// Data only; a test compares the copy with the contract and the commit with the pin.
import { z } from "zod";
import raw from "./opencode-providers.v1.json" with { type: "json" };
import {
  AUTH_HEADERS,
  EXCLUSION_REASONS,
  WIRE_FAMILIES,
  type ExclusionReason,
} from "./wire.ts";

const supportedSchema = z.strictObject({
  npm: z.string().min(1),
  family: z.enum(WIRE_FAMILIES),
  authHeader: z.enum(AUTH_HEADERS),
  defaultBaseUrl: z.string().min(1).optional(),
});
const excludedSchema = z.strictObject({ excluded: z.enum(EXCLUSION_REASONS) });
const fileSchema = z.strictObject({
  version: z.literal(1),
  opencode: z.strictObject({
    version: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  providers: z.record(z.string(), z.union([supportedSchema, excludedSchema])),
});

export type SupportedProvider = z.infer<typeof supportedSchema>;
export type ProvidersFile = z.infer<typeof fileSchema>;

export const OPENCODE_PROVIDERS: ProvidersFile = fileSchema.parse(raw);

/** The entry of a provider the job can use, or undefined for an excluded or unknown one. */
export function supportedProvider(id: string): SupportedProvider | undefined {
  if (!Object.hasOwn(OPENCODE_PROVIDERS.providers, id)) return undefined;
  const entry = OPENCODE_PROVIDERS.providers[id];
  return entry !== undefined && "family" in entry ? entry : undefined;
}

/** Why a provider is left out; undefined for a supported or an unknown one. */
export function excludedReason(id: string): ExclusionReason | undefined {
  if (!Object.hasOwn(OPENCODE_PROVIDERS.providers, id)) return undefined;
  const entry = OPENCODE_PROVIDERS.providers[id];
  return entry !== undefined && "excluded" in entry
    ? entry.excluded
    : undefined;
}
