// SPDX-License-Identifier: LicenseRef-Proprietary

// Which Dynamic model a project save has to put to the provider's metadata check, and at which provider (#269, #430).
// A model is only meaningful at the provider it belongs to, so the check follows the provider the project selected.
import type { ProjectDynamicPatch } from "./settings.ts";

export type DynamicModelCheck = { model: string; provider: string };

/**
 * The model to check, or null when there is nothing new to vouch for:
 *
 * - the request sets a model: that model, at the provider of the request, else the stored one, else the default;
 * - the request only changes the provider (sets or clears it): the stored model, now at that provider, if there is one;
 * - anything else (no model and no provider in the request, or a cleared model) checks nothing, and a value that is
 *   already stored is left alone (#269-T09).
 */
export function dynamicModelToCheck(
  patch: ProjectDynamicPatch,
  stored: { dynamicModel?: string; dynamicProvider?: string },
  defaultProvider: string,
): DynamicModelCheck | null {
  const provider =
    patch.dynamicProvider === undefined
      ? (stored.dynamicProvider ?? defaultProvider)
      : (patch.dynamicProvider ?? defaultProvider);
  if (typeof patch.dynamicModel === "string")
    return { model: patch.dynamicModel, provider };
  if (patch.dynamicModel === undefined && patch.dynamicProvider !== undefined)
    return stored.dynamicModel === undefined
      ? null
      : { model: stored.dynamicModel, provider };
  return null;
}
