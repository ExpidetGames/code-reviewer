// SPDX-License-Identifier: LicenseRef-Proprietary

// Models of the settings form for the tests of the LLM section (#656): a project of a workspace on its own key and one of
// a workspace on the operator's key, whose views carry no provider and no model (ADR 0005). `leak` plants a sentinel where
// a model would sit if a view ever carried one, so a test can prove that the form shows and sends none.
import { vi } from "vitest";
import { estimateReviewCost } from "../review-settings/cost.ts";
import type { CatalogChoices } from "../review-settings/catalog-selection.ts";
import { DEFAULT_REVIEW_SKILL } from "../review-settings/default-skill.ts";
import type {
  GlobalSettingsView,
  ProjectDynamicView,
} from "../review-settings/service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
  withoutModelFields,
  type ReviewSettings,
} from "../review-settings/settings.ts";
import type { SettingsApi } from "../review-settings/ui/api.ts";
import type { SettingsFormModel } from "../review-settings/ui/form-model.ts";

export const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
export const SENTINEL = "sentinel-vendor/secret-model-9";

export function dynamicView(
  kind: "diff" | "dynamic",
  managed: boolean,
): ProjectDynamicView {
  const effective: ProjectDynamicView["effective"] = {
    reviewKind: kind,
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    dynamicProvider: "openrouter",
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  };
  const defaults: ProjectDynamicView["defaults"] = {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    dynamicProvider: "openrouter",
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  };
  const sources: ProjectDynamicView["sources"] = {
    reviewKind: "built_in",
    dynamicModel: "built_in",
    dynamicProvider: "built_in",
    reviewSkill: "built_in",
    reviewVerdict: "built_in",
  };
  if (managed)
    for (const field of ["dynamicModel", "dynamicProvider"] as const) {
      delete effective[field];
      delete defaults[field];
      delete sources[field];
    }
  return {
    overrides: {},
    effective,
    sources,
    defaults,
    reviewSkillIsDefault: true,
    defaultSkill: {
      id: DEFAULT_REVIEW_SKILL.id,
      version: DEFAULT_REVIEW_SKILL.version,
      hash: DEFAULT_REVIEW_SKILL.hash,
    },
    limits: { reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes },
  };
}

/** The form model of a project (or of the workspace defaults) of a workspace on its own key. */
export function ownModel(
  options: {
    kind?: "diff" | "dynamic";
    mode?: "project" | "global";
    overrides?: SettingsFormModel["overrides"];
    inherited?: ReviewSettings;
    /** The operator's maximum per review in cents (#689); default 1.00 USD. */
    operatorMaxCostCents?: number;
  } = {},
): SettingsFormModel {
  const inherited = options.inherited ?? BUILT_IN;
  const overrides = options.overrides ?? {};
  const effective = { ...inherited, ...overrides };
  return {
    mode: options.mode ?? "project",
    inherited,
    overrides,
    effective,
    sources: Object.fromEntries(
      Object.keys(effective).map((field) => [
        field,
        Object.hasOwn(overrides, field) ? "project" : "built_in",
      ]),
    ) as SettingsFormModel["sources"],
    cost: estimateReviewCost(effective),
    operatorMaxCostCents: options.operatorMaxCostCents ?? 100,
    managed: false,
    catalog: null,
    lastSaved: null,
    dynamic: dynamicView(options.kind ?? "diff", false),
  };
}

export const CHOICES: CatalogChoices = {
  diff: [
    {
      id: "ent-fast",
      name: "Quick look",
      description: "Fast passes over small changes.",
      providerLabel: "Anthropic",
      available: true,
      reason: null,
    },
    {
      id: "ent-thorough",
      name: "Thorough",
      description: "Careful passes over large changes.",
      providerLabel: "OpenAI",
      available: true,
      reason: null,
    },
    {
      id: "ent-premium",
      name: "Premium",
      description: "The deepest passes we offer.",
      providerLabel: "OpenAI",
      available: false,
      reason: "CATALOG_ENTRY_NOT_ALLOWED",
    },
  ],
  dynamic: [
    {
      id: "ent-explorer",
      name: "Explorer",
      description: "Explores the repository around a change.",
      providerLabel: "Anthropic",
      available: true,
      reason: null,
    },
    {
      id: "ent-detective",
      name: "Detective",
      description: "Follows every call to the end.",
      providerLabel: "Google",
      available: true,
      reason: null,
    },
  ],
};

/** The form model of a managed workspace: the views carry no model and no provider, only the catalog view. */
export function managedModel(
  options: {
    kind?: "diff" | "dynamic";
    mode?: "project" | "global";
    choices?: CatalogChoices;
    selection?: { diff: string | null; dynamic: string | null };
    /** The entries the workspace defaults select, which a project that selects none follows (#676). */
    workspaceSelection?: { diff: string | null; dynamic: string | null };
    leak?: boolean;
  } = {},
): SettingsFormModel {
  const readable = withoutModelFields(BUILT_IN);
  const mode = options.mode ?? "project";
  const leaked = options.leak
    ? { model: SENTINEL, provider: SENTINEL, fallbackModel: SENTINEL }
    : {};
  const dynamic = dynamicView(options.kind ?? "diff", true);
  if (options.leak) {
    dynamic.effective = {
      ...dynamic.effective,
      dynamicModel: SENTINEL,
      dynamicProvider: SENTINEL as never,
    };
  }
  return {
    mode,
    inherited: readable,
    overrides: {},
    effective: { ...readable, ...leaked } as SettingsFormModel["effective"],
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as SettingsFormModel["sources"],
    cost: null,
    operatorMaxCostCents: 100,
    managed: true,
    catalog: {
      choices: options.choices ?? CHOICES,
      selection: options.selection ?? { diff: null, dynamic: null },
      workspaceSelection:
        mode === "project"
          ? (options.workspaceSelection ?? { diff: null, dynamic: null })
          : null,
    },
    lastSaved: null,
    dynamic,
  };
}

/** The view of the workspace defaults of a workspace on its own key that saved nothing yet (#676). */
export function untouchedGlobalView(): GlobalSettingsView {
  return {
    overrides: {},
    effective: BUILT_IN,
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as GlobalSettingsView["sources"],
    cost: estimateReviewCost(BUILT_IN),
    modelManagedByInstance: false,
    operatorMaxCostCents: 100,
    builtIn: BUILT_IN,
    updatedAt: null,
    updatedBy: null,
    dynamic: dynamicView("diff", false),
    catalogChoices: null,
    catalogSelection: null,
    followingProjects: 0,
  };
}

export function fakeApi() {
  const save = vi.fn<SettingsApi["save"]>(async () => ({
    ok: true,
    data: {},
  }));
  return {
    api: {
      save,
      reset: vi.fn<NonNullable<SettingsApi["reset"]>>(async () => ({
        ok: true,
        data: {},
      })),
    } satisfies SettingsApi,
    save,
  };
}
