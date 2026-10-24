// SPDX-License-Identifier: LicenseRef-Proprietary

// What a request to change an operator LLM key says, read into one provider and one change (#427). Two shapes
// reach the settings route:
//
//   { "operatorLlmKeys": { "<provider>": { "apiKey": "..." } | null } }   the key of one provider; `null` removes it
//   { "operatorLlmKey": { "apiKey": "..." } | null }                      the shape before there were several
//                                                                          providers: the default provider's key,
//                                                                          accepted for one more release
//
// A request changes one provider's key: none or several entries are refused rather than half applied. The provider
// is named by its id exactly (the registry's, no trimming and no case folding), so a spelling that is not an id
// never reaches a secret name. The value of the key itself is the key service's to judge (src/llm/operator-key.ts).
import type { OperatorProviderLookup } from "../llm/workspace-key.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import type { SetupIssue } from "../setup/errors.ts";

export type OperatorKeyChange =
  | {
      ok: true;
      provider: string;
      /** `{ apiKey }` as received, to save; null to remove the key. */
      change: { apiKey: unknown } | null;
    }
  | { ok: false; issues: SetupIssue[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (field: string): OperatorKeyChange => ({
  ok: false,
  issues: [{ field, code: "operator_llm_key_invalid" }],
});

export function parseOperatorKeyChange(
  setting: "operatorLlmKey" | "operatorLlmKeys",
  value: unknown,
  providers: OperatorProviderLookup,
): OperatorKeyChange {
  if (setting === "operatorLlmKey") {
    if (value === null)
      return { ok: true, provider: DEFAULT_LLM_PROVIDER, change: null };
    if (!isObject(value)) return invalid(setting);
    return {
      ok: true,
      provider: DEFAULT_LLM_PROVIDER,
      change: { apiKey: value.apiKey },
    };
  }

  if (!isObject(value)) return invalid(setting);
  const entries = Object.entries(value);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) return invalid(setting);
  const [provider, change] = entry;
  if (providers.find(provider)?.id !== provider)
    return {
      ok: false,
      issues: [{ field: "provider", code: "provider_invalid" }],
    };
  if (change === null) return { ok: true, provider, change: null };
  if (!isObject(change)) return invalid(setting);
  return { ok: true, provider, change: { apiKey: change.apiKey } };
}
