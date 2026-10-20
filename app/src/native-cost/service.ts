// SPDX-License-Identifier: Apache-2.0

// What the claim asks about the cost of a native job (#553): which catalog model a selection names, and the cost policy
// of its key (policy.ts). It reads the price service (`availability` for the managed key, `catalogPrice` for the own key)
// and the token cap of the instance; it decides nothing the pure modules do not. Server side only: it names providers,
// models and prices, none of which reaches a member.
import "server-only";
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { ModelPriceService } from "../model-prices/service.ts";
import {
  catalogRefOf,
  nativeProviderIdOf,
  type CatalogRef,
} from "./catalog-ref.ts";
import {
  managedPolicy,
  ownPolicy,
  type CostPolicyJson,
  type ManagedPolicyOutcome,
} from "./policy.ts";
import { ownKeyTokenCapOf } from "./token-cap.ts";

export type PolicyOutcome =
  | {
      ok: true;
      policy: CostPolicyJson;
      /** The confirmation that priced a managed run; null for an own key. */
      confirmation: { id: number; hashVersion: number } | null;
    }
  | Extract<ManagedPolicyOutcome, { ok: false }>;

export type NativeCostService = {
  /** The catalog model a selection names, or null when the job does not take the native path (catalog-ref.ts). */
  refOf(selection: { provider: string; model: string }): CatalogRef | null;
  /** Whether a provider slug (as a usage record remembers it) is a native one: the job it served was native. */
  isNativeProvider(slug: string): boolean;
  /**
   * The cost policy of a job on this key. `managed`: only a model that is enabled and has a confirmed price passes; the
   * refusal carries a stable code (`catalog_price_unconfirmed`, `catalog_model_unavailable`) and an internal reason, both
   * for the log. `own`: always a policy, with the catalog's price when it states one and the instance's token cap. Never
   * throws: the price service answers a failed read as a refusal (managed) or as no price (own).
   */
  policyFor(
    keyMode: "managed" | "own",
    ref: CatalogRef,
  ): Promise<PolicyOutcome>;
};

export function createNativeCostService(deps: {
  prices: Pick<ModelPriceService, "availability" | "catalogPrice">;
  settings: Pick<InstanceSettingsRepository, "get">;
  /** The providers of the app's registry, which keep the legacy path until #556. */
  legacyProviders: readonly string[];
}): NativeCostService {
  return {
    refOf: (selection) => catalogRefOf(selection, deps.legacyProviders),
    isNativeProvider: (slug) =>
      nativeProviderIdOf(slug, deps.legacyProviders) !== null,

    async policyFor(keyMode, ref) {
      if (keyMode === "managed")
        return managedPolicy(
          await deps.prices.availability(ref.providerId, ref.modelId),
        );
      const [book, stored] = await Promise.all([
        deps.prices.catalogPrice(ref.providerId, ref.modelId),
        deps.settings.get("own_key_max_total_tokens"),
      ]);
      return {
        ok: true,
        policy: ownPolicy(book, ownKeyTokenCapOf(stored)),
        confirmation: null,
      };
    },
  };
}
