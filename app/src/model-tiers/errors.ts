// SPDX-License-Identifier: Apache-2.0

// The codes the operator API answers with (422) when the configuration of the managed tiers is refused. The first is the
// validation of a model id; the rest come from the check of a Dynamic model against the provider's metadata (#269) and
// are spelled as the review settings spell them. Here an unverifiable model is refused too: it is operator
// configuration, not a user's choice.
export const MODEL_TIER_ERROR_CODES = [
  "model_id_invalid",
  /** A Diff model the provider's metadata does not list (a typo would fail every job of the tier at run time). */
  "MODEL_UNKNOWN",
  "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
  "DYNAMIC_MODEL_UNKNOWN",
  "DYNAMIC_MODEL_UNVERIFIED",
] as const;
export type ModelTierErrorCode = (typeof MODEL_TIER_ERROR_CODES)[number];
