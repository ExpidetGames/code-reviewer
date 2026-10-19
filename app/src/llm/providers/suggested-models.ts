// SPDX-License-Identifier: Apache-2.0

// The models a form suggests for a review kind (#532): the provider's suggestions, narrowed to the ones that can serve
// the kind when the provider says that not all of them can. Data and pure rules, safe for a client component to import.
import type { ReviewKind } from "../../contracts/runner-api.ts";
import type { LlmProviderDescriptor } from "./types.ts";

/** What the suggestions need of a provider. */
export type SuggestingProvider = Pick<
  LlmProviderDescriptor,
  "suggestedModels" | "dynamicSuggestedModels"
>;

/**
 * The models to suggest for a review kind: every suggestion for Diff Review, and for Dynamic Review the provider's
 * narrower list when it has one. Never the only allowed models: any id the provider accepts may still be typed.
 */
export function suggestedModelsFor(
  provider: SuggestingProvider,
  kind: ReviewKind,
): readonly string[] {
  return kind === "dynamic"
    ? (provider.dynamicSuggestedModels ?? provider.suggestedModels)
    : provider.suggestedModels;
}
