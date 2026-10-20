// SPDX-License-Identifier: Apache-2.0

// Whether the managed key, which we pay, may use a catalog model (#549; the claim of #553 asks it at claim time). A model is
// selectable only if the admin has enabled it **and** its price is confirmed and still is: a price that models.dev or the
// override file changed after the confirmation counts as unconfirmed until the admin confirms again. Besides that, the
// provider must be one the job may carry a key to (a supported provider with a trusted address, `buildJobModelEntry`), and
// the override file must neither block the model nor have retired it. A model that models.dev no longer lists stays
// selectable until the admin disables it (the maintainer decision of 2026-10-19). Pure; the reason is internal, a member
// is told nothing but that the model is unavailable.
import "server-only";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import { buildJobModelEntry } from "../models-dev/job-entry.ts";
import type { EffectivePrice } from "./effective-price.ts";
import type { ModelOverride } from "./overrides.ts";
import type { PriceBook } from "./price-book.ts";

export const MANAGED_UNAVAILABLE_REASONS = [
  /** The catalog has no such provider or model. */
  "model_unknown",
  /** The provider is not one the job may carry a key to. */
  "provider_unsupported",
  /** The provider's address is not trusted: never safe, or changed and waiting for an admin. */
  "provider_url_blocked",
  /** The catalog row does not make an entry the contract allows. */
  "model_entry_invalid",
  /** The override file blocks the model. */
  "model_blocked",
  /** The override file retired the model: its date has passed. */
  "model_retired",
  /** The admin has not enabled the model, or has disabled it. */
  "model_not_enabled",
  /** The price is not confirmed: never confirmed, changed since, or not priced. */
  "price_unconfirmed",
] as const;
export type ManagedUnavailableReason =
  (typeof MANAGED_UNAVAILABLE_REASONS)[number];

export type ManagedAvailability =
  /** `book` is the confirmed price the ledger prices the run from. */
  | { selectable: true; book: PriceBook }
  | { selectable: false; reason: ManagedUnavailableReason };

export type ManagedAvailabilityInput = {
  provider: StoredProvider | undefined;
  model: StoredModel | undefined;
  enabled: boolean;
  override: ModelOverride | undefined;
  price: EffectivePrice;
  now: Date;
};

const no = (reason: ManagedUnavailableReason): ManagedAvailability => ({
  selectable: false,
  reason,
});

export function managedAvailability(
  input: ManagedAvailabilityInput,
): ManagedAvailability {
  const { provider, model, override, price } = input;
  if (provider === undefined || model === undefined) return no("model_unknown");
  const entry = buildJobModelEntry(provider, model);
  if (!entry.ok) {
    if (entry.code === "provider_unsupported")
      return no("provider_unsupported");
    if (entry.code === "provider_url_blocked")
      return no("provider_url_blocked");
    return no(
      entry.code === "model_not_of_provider"
        ? "model_unknown"
        : "model_entry_invalid",
    );
  }
  if (override?.blocked === true) return no("model_blocked");
  if (
    override?.retiresNotBefore != null &&
    input.now.toISOString().slice(0, 10) > override.retiresNotBefore
  )
    return no("model_retired");
  if (!input.enabled) return no("model_not_enabled");
  if (price.status !== "confirmed" || price.book === null)
    return no("price_unconfirmed");
  return { selectable: true, book: price.book };
}
