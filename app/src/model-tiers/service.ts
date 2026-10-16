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
   * is operator configuration and not a user's choice. Nothing is stored on a refusal.
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

  /** The first Dynamic model the provider's metadata does not vouch for, as a refusal; undefined when all pass. */
  async function refuseUnsuitableDynamicModels(
    tiers: ManagedModelTiers,
  ): Promise<Extract<SaveTiersResult, { ok: false }> | undefined> {
    const answers = new Map<
      string,
      Awaited<ReturnType<ModelCapabilityChecker["check"]>>
    >();
    for (const [tier, models] of Object.entries(tiers)) {
      const model = models.dynamic;
      if (model === undefined) continue;
      let result = answers.get(model);
      if (result === undefined) {
        result = await modelCapabilities.check(model);
        answers.set(model, result);
      }
      const field = `${tier}.dynamic`;
      switch (result.outcome) {
        case "supported":
          break;
        case "unsupported":
          return { ok: false, code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED", field };
        case "unknown_model":
          return { ok: false, code: "DYNAMIC_MODEL_UNKNOWN", field };
        case "unverifiable":
          return { ok: false, code: "DYNAMIC_MODEL_UNVERIFIED", field };
      }
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
      const refused = await refuseUnsuitableDynamicModels(checked.tiers);
      if (refused !== undefined) return refused;
      await settings.set("managed_model_tiers", checked.tiers, updatedBy);
      return { ok: true, tiers: checked.tiers };
    },
  };
}
