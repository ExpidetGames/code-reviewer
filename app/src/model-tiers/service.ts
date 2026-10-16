// SPDX-License-Identifier: Apache-2.0

// The operator's configuration of the managed model tiers (#280): which model backs each tier for each kind of
// review. Read by the claim of a job of a managed workspace, written through the operator API only. The one place that
// reads and writes the instance setting `managed_model_tiers`, so what is stored is always what `checkManagedModelTiers`
// accepts and the reader checks again (a damaged value reads as not configured, and the job fails closed).
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { ModelTierErrorCode } from "./errors.ts";
import {
  checkManagedModelTiers,
  MODEL_TIERS,
  TIER_REVIEW_KINDS,
  modelOfTier,
  readStoredTiers,
  type ManagedModelTiers,
  type ModelTier,
  type ModelTierCheckCode,
} from "./tiers.ts";

export type SaveTiersResult =
  | { ok: true; tiers: ManagedModelTiers }
  | {
      ok: false;
      code: ModelTierCheckCode | ModelTierErrorCode;
      field?: string;
    };

export type ModelTiersService = {
  /** The configuration as stored (what this version accepts); `{}` when none. */
  read(): Promise<ManagedModelTiers>;
  /** The model a tier has for a kind of review, or null: no other tier stands in. */
  modelFor(tier: ModelTier, kind: ProjectReviewKind): Promise<string | null>;
  /**
   * Replaces the configuration. A Dynamic model is checked against the provider's metadata (#269): one without tool
   * calling or choice, one the provider does not know and one that cannot be verified are all refused, because this
   * is operator configuration and not a user's choice. A Diff model the provider does not know is refused too; one that
   * cannot be verified is accepted. Nothing is stored on a refusal.
   */
  save(input: unknown, updatedBy: string | null): Promise<SaveTiersResult>;
};

/** What the claim needs: the model of a tier for a kind. */
export type ModelTierSource = Pick<ModelTiersService, "modelFor">;

/** A source with nothing configured: every managed job fails closed (for tests that are not about tiers). */
export const noModelTiers: ModelTierSource = { modelFor: async () => null };

export function createModelTiersService(deps: {
  settings: Pick<InstanceSettingsRepository, "get" | "set" | "remove">;
  modelCapabilities: ModelCapabilityChecker;
}): ModelTiersService {
  const { settings, modelCapabilities } = deps;

  async function read(): Promise<ManagedModelTiers> {
    return readStoredTiers(await settings.get("managed_model_tiers"));
  }

  /**
   * The first model the provider's metadata does not vouch for, as a refusal; undefined when all pass. Every distinct
   * model is asked once, all at the same time (a PUT of six unreachable models waits for one timeout, not six); the
   * answers are then judged in the order of the tiers, so the refusal does not depend on which read finished first.
   * A Dynamic model needs tool calling and tool choice and must be verifiable (operator configuration, not a user's
   * choice); a Diff model needs no tool support and may be unverifiable (the provider is unreachable), but a model the
   * provider does not know is a typo that would fail every job of the tier.
   */
  async function refuseUnsuitableModels(
    tiers: ManagedModelTiers,
  ): Promise<Extract<SaveTiersResult, { ok: false }> | undefined> {
    const distinct = [
      ...new Set(
        MODEL_TIERS.flatMap((tier) =>
          TIER_REVIEW_KINDS.map((kind) => tiers[tier]?.[kind]),
        ).filter((model): model is string => model !== undefined),
      ),
    ];
    const answers = new Map(
      await Promise.all(
        distinct.map(
          async (model) =>
            [model, await modelCapabilities.check(model)] as const,
        ),
      ),
    );
    for (const tier of MODEL_TIERS)
      for (const kind of TIER_REVIEW_KINDS) {
        const model = tiers[tier]?.[kind];
        if (model === undefined) continue;
        const result = answers.get(model);
        if (result === undefined) continue;
        const field = `${tier}.${kind}`;
        if (result.outcome === "unknown_model")
          return {
            ok: false,
            code:
              kind === "dynamic" ? "DYNAMIC_MODEL_UNKNOWN" : "MODEL_UNKNOWN",
            field,
          };
        if (kind !== "dynamic") continue;
        if (result.outcome === "unsupported")
          return { ok: false, code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED", field };
        if (result.outcome === "unverifiable")
          return { ok: false, code: "DYNAMIC_MODEL_UNVERIFIED", field };
      }
    return undefined;
  }

  return {
    read,

    async modelFor(tier, kind) {
      return modelOfTier(await read(), tier, kind);
    },

    async save(input, updatedBy) {
      const checked = checkManagedModelTiers(input);
      if (!checked.ok)
        return checked.field === undefined
          ? { ok: false, code: checked.code }
          : { ok: false, code: checked.code, field: checked.field };
      const refused = await refuseUnsuitableModels(checked.tiers);
      if (refused !== undefined) return refused;
      await settings.set("managed_model_tiers", checked.tiers, updatedBy);
      return { ok: true, tiers: checked.tiers };
    },
  };
}
