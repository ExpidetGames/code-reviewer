// SPDX-License-Identifier: LicenseRef-Proprietary

// Which Dynamic provider and model a project save leaves a project with when the provider is a catalog provider (#555), and
// whether the save has to put that pair to the catalog. Pure. A catalog provider has no built-in model and no model metadata
// of its own to ask (the catalog is the list), so a pair is checked against the catalog or not at all.
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { nativeProviderIdOf } from "../native-cost/catalog-ref.ts";
import type {
  ProjectDynamicOverrides,
  ProjectDynamicPatch,
} from "./settings.ts";

/** Whether a provider id (as stored) is a catalog provider: supported, and not one of the registry's. */
export function isNativeProvider(provider: string): boolean {
  return nativeProviderIdOf(provider, llmProviderDescriptors.ids) !== null;
}

export type NativeDynamicChoice = {
  provider: string;
  /** The model the project is left with; null when it has none (a catalog provider needs one). */
  model: string | null;
  /**
   * The save sets the provider or the model. Only then is the pair put to the catalog: a pair that is already stored is left
   * alone (a model may have left the catalog since, and an unrelated save must not fail for it).
   */
  changed: boolean;
};

/** The catalog pair the project has after the save, or null when its Dynamic provider is not a catalog provider. */
export function nativeDynamicChoice(
  patch: ProjectDynamicPatch,
  stored: Pick<ProjectDynamicOverrides, "dynamicProvider" | "dynamicModel">,
): NativeDynamicChoice | null {
  const provider =
    patch.dynamicProvider === undefined
      ? stored.dynamicProvider
      : (patch.dynamicProvider ?? undefined);
  if (provider === undefined || !isNativeProvider(provider)) return null;
  const model =
    patch.dynamicModel === undefined
      ? (stored.dynamicModel ?? null)
      : patch.dynamicModel;
  return {
    provider,
    model,
    changed:
      typeof patch.dynamicProvider === "string" ||
      typeof patch.dynamicModel === "string",
  };
}
