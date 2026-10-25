// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the layers (built-in values, global defaults, project overrides) become the settings
// of one review, and what the switches for triggers and commands mean.
import { describe, expect, it } from "vitest";
import {
  isAutomaticReviewEnabled,
  isCommandAllowed,
  resolveProjectDynamicSettings,
  resolveReviewSettings,
} from "./effective.ts";
import {
  parseStoredOverrides,
  parseStoredProjectDynamicOverrides,
} from "./validate.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import { MODEL_PRICES } from "../llm/providers/openrouter/model-pricing.ts";
import {
  DEFAULT_DYNAMIC_MODEL,
  DEFAULT_MAX_TOKENS,
  builtInProjectDynamicSettings,
  builtInReviewSettings,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "./settings.ts";

const builtIn = builtInReviewSettings("deepseek/deepseek-v3.2");
const SHIPPED_SKILL = "# shipped default skill";

describe("the built-in review settings", () => {
  // CR-25-T01
  it("give the token budget well above PR-Agent's 32000 and switch large pull request chunking on", () => {
    const { settings } = resolveReviewSettings({ builtIn });

    expect(settings.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(settings.maxTokens).toBeGreaterThan(32_000);
    expect(settings.largePrChunking).toBe(true);
  });

  it("use the model they are given and have no fallback and no project rules", () => {
    expect(builtInReviewSettings("qwen/qwen3-coder").model).toBe(
      "qwen/qwen3-coder",
    );
    expect(builtIn).toMatchObject({
      fallbackModel: null,
      extraInstructions: "",
      inlineKeyIssues: false,
      autoReviewOnOpen: true,
      autoReviewOnPush: true,
      allowedCommands: ["review"],
    });
  });
});

describe("resolving the settings of a project", () => {
  // CR-25-T01
  it("is the global defaults when the project overrides nothing", () => {
    const global: ReviewSettingsOverrides = {
      model: "qwen/qwen3-coder",
      maxFindings: 8,
    };

    const { settings, sources } = resolveReviewSettings({
      builtIn,
      global,
      project: {},
    });

    expect(settings).toEqual({ ...builtIn, ...global });
    expect(sources.model).toBe("global");
    expect(sources.maxFindings).toBe("global");
    expect(sources.maxTokens).toBe("built_in");
  });

  // CR-25-T02
  it("takes the project's value for the two fields it overrides and the global value for the rest", () => {
    const global: ReviewSettingsOverrides = {
      model: "qwen/qwen3-coder",
      maxFindings: 8,
      inlineKeyIssues: true,
    };
    const project: ReviewSettingsOverrides = {
      maxFindings: 2,
      extraInstructions: "Prefer small functions.",
    };

    const { settings, sources } = resolveReviewSettings({
      builtIn,
      global,
      project,
    });

    expect(settings.maxFindings).toBe(2);
    expect(settings.extraInstructions).toBe("Prefer small functions.");
    expect(settings.model).toBe("qwen/qwen3-coder");
    expect(settings.inlineKeyIssues).toBe(true);
    expect(settings.maxTokens).toBe(builtIn.maxTokens);
    expect(sources).toMatchObject({
      maxFindings: "project",
      extraInstructions: "project",
      model: "global",
      inlineKeyIssues: "global",
      maxTokens: "built_in",
    });
  });

  it("lets a project switch a global value off, and drop a global fallback model or rules", () => {
    const { settings } = resolveReviewSettings({
      builtIn,
      global: {
        largePrChunking: true,
        fallbackModel: "qwen/qwen3-coder",
        extraInstructions: "Be strict.",
        allowedCommands: ["review"],
      },
      project: {
        largePrChunking: false,
        fallbackModel: null,
        extraInstructions: "",
        allowedCommands: [],
      },
    });

    expect(settings).toMatchObject({
      largePrChunking: false,
      fallbackModel: null,
      extraInstructions: "",
      allowedCommands: [],
    });
  });

  it("shares no list with the layers it was made from", () => {
    const global: ReviewSettingsOverrides = { allowedCommands: [] };

    const { settings } = resolveReviewSettings({ builtIn, global });
    settings.allowedCommands.push("review");

    expect(global.allowedCommands).toEqual([]);
    expect(builtIn.allowedCommands).toEqual(["review"]);
  });
});

describe("the default Dynamic model", () => {
  // #262-T01
  it("is a model id OpenRouter serves, with the vendor prefix, as the price table spells it", () => {
    expect(DEFAULT_DYNAMIC_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(Object.keys(MODEL_PRICES)).toContain(DEFAULT_DYNAMIC_MODEL);
  });
});

describe("the project-only review kind, model and skill", () => {
  // #194-T01
  it("default a project without the fields to Diff Review, the shipped Dynamic model and the shipped skill", () => {
    const dynamic = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      defaultSkill: SHIPPED_SKILL,
    });

    expect(dynamic.reviewKind).toBe("diff");
    // The required default model, pinned literally so a mutation of the production constant cannot
    // pass this test (#194-T01). It is the id OpenRouter serves, sent verbatim (#262-T01, #262-T02).
    expect(dynamic.dynamicModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(dynamic.reviewSkill).toBe(SHIPPED_SKILL);
    expect(dynamic.reviewSkillIsDefault).toBe(true);
    // #405-T28: the default verdict mode is the one that blocks on the highest severity only.
    expect(dynamic.reviewVerdict).toBe("blocking");
    expect(dynamic.sources).toEqual({
      reviewKind: "built_in",
      dynamicModel: "built_in",
      dynamicProvider: "built_in",
      catalogEntryDiff: "built_in",
      catalogEntryDynamic: "built_in",
      reviewSkill: "built_in",
      reviewVerdict: "built_in",
    });
  });

  // #405-T28
  it("take the verdict mode of the project, whatever its review kind, and fall back to the default when it is cleared", () => {
    for (const reviewKind of ["diff", "dynamic"] as const) {
      const set = resolveProjectDynamicSettings({
        builtIn: builtInProjectDynamicSettings(),
        project: { reviewKind, reviewVerdict: "any" },
        defaultSkill: SHIPPED_SKILL,
      });
      expect(set.reviewVerdict).toBe("any");
      expect(set.sources.reviewVerdict).toBe("project");
    }
    const off = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: { reviewVerdict: "off" },
      defaultSkill: SHIPPED_SKILL,
    });
    expect(off.reviewVerdict).toBe("off");
    expect(
      resolveProjectDynamicSettings({
        builtIn: builtInProjectDynamicSettings(),
        project: {},
        defaultSkill: SHIPPED_SKILL,
      }).reviewVerdict,
    ).toBe("blocking");
  });

  // #194-T01
  it("switch to Dynamic and back while each kind keeps its own model and skill", () => {
    const builtInDynamic = builtInProjectDynamicSettings();
    const stored = {
      reviewKind: "dynamic" as const,
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "review for the Dynamic kind",
      model: "diff/model",
    };

    const asDynamic = resolveProjectDynamicSettings({
      builtIn: builtInDynamic,
      project: stored,
      defaultSkill: SHIPPED_SKILL,
    });
    const asDiff = resolveProjectDynamicSettings({
      builtIn: builtInDynamic,
      project: { ...stored, reviewKind: "diff" },
      defaultSkill: SHIPPED_SKILL,
    });

    expect(asDynamic.reviewKind).toBe("dynamic");
    expect(asDynamic.sources.reviewKind).toBe("project");
    // The Diff model and the Dynamic model are independent; switching kinds changes neither.
    expect(
      resolveReviewSettings({ builtIn, project: stored }).settings.model,
    ).toBe("diff/model");
    expect(asDiff.dynamicModel).toBe("vendor/dynamic-model");
    expect(asDiff.reviewSkill).toBe("review for the Dynamic kind");
  });

  // #194-T01
  it("resolve a cleared skill override to the shipped default, not to another project's skill", () => {
    const dynamic = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: { reviewSkill: null },
      defaultSkill: SHIPPED_SKILL,
    });

    expect(dynamic.reviewSkill).toBe(SHIPPED_SKILL);
    expect(dynamic.reviewSkillIsDefault).toBe(true);
    expect(dynamic.sources.reviewSkill).toBe("built_in");
  });

  // #194-T08
  it("keep an alternative configured model identifier literally, without a provider rewrite", () => {
    const dynamic = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: { reviewKind: "dynamic", dynamicModel: "vendor/alt-model-2" },
      defaultSkill: SHIPPED_SKILL,
    });

    expect(dynamic.dynamicModel).toBe("vendor/alt-model-2");
    expect(dynamic.sources.dynamicModel).toBe("project");
  });

  // #198-T06
  it("resolve a reset to the shipped skill of the current version, not a stale one", () => {
    // The shipped default is resolved from the seam at read time, so a new version of it reaches
    // every project without an override, while an explicit override stays untouched.
    const shippedV2 = "# shipped default skill, version 2";
    const reset = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: { reviewSkill: null },
      defaultSkill: shippedV2,
    });
    const overridden = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: { reviewSkill: "keep my own skill" },
      defaultSkill: shippedV2,
    });

    expect(reset.reviewSkill).toBe(shippedV2);
    expect(reset.reviewSkillIsDefault).toBe(true);
    expect(overridden.reviewSkill).toBe("keep my own skill");
    expect(overridden.reviewSkillIsDefault).toBe(false);
  });
});

describe("automatic reviews and commands", () => {
  // CR-25-T04
  it.each([
    [{ autoReviewOnOpen: true, autoReviewOnPush: false }, "opened", true],
    [{ autoReviewOnOpen: true, autoReviewOnPush: false }, "updated", false],
    [{ autoReviewOnOpen: false, autoReviewOnPush: true }, "opened", false],
    [{ autoReviewOnOpen: false, autoReviewOnPush: true }, "updated", true],
    [{ autoReviewOnOpen: false, autoReviewOnPush: false }, "opened", false],
    [{ autoReviewOnOpen: false, autoReviewOnPush: false }, "updated", false],
  ] as const)(
    "with %j a pull request that was %s starts a review: %s",
    (switches, trigger, expected) => {
      expect(
        isAutomaticReviewEnabled({ ...builtIn, ...switches }, trigger),
      ).toBe(expected);
    },
  );

  // CR-25-T04, #203-T07
  it("allows review only when the list holds it", () => {
    const settings: ReviewSettings = {
      ...builtIn,
      allowedCommands: ["review"],
    };

    expect(isCommandAllowed(settings, "review")).toBe(true);
    expect(
      isCommandAllowed({ ...builtIn, allowedCommands: [] }, "review"),
    ).toBe(false);
  });
});

// #430: the provider and the catalog entry (ADR 0005, 2.7).
describe("the provider and catalog selection", () => {
  // #430-T02
  it("layers the provider: the project over the workspace default over the default provider", () => {
    const layers = { builtIn };
    expect(resolveReviewSettings(layers).settings.provider).toBe(
      DEFAULT_LLM_PROVIDER,
    );
    expect(resolveReviewSettings(layers).sources.provider).toBe("built_in");

    const global = resolveReviewSettings({
      ...layers,
      global: { provider: "workspace_provider" as never },
    });
    expect(global.settings.provider).toBe("workspace_provider");
    expect(global.sources.provider).toBe("global");

    const project = resolveReviewSettings({
      ...layers,
      global: { provider: "workspace_provider" as never },
      project: { provider: "project_provider" as never },
    });
    expect(project.settings.provider).toBe("project_provider");
    expect(project.sources.provider).toBe("project");
  });

  // #430-T02
  it("takes the Dynamic provider and the catalog entries from the project only, with no workspace layer", () => {
    const none = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      defaultSkill: SHIPPED_SKILL,
    });
    expect(none.dynamicProvider).toBe(DEFAULT_LLM_PROVIDER);
    expect(none.catalogEntryDiff).toBeNull();
    expect(none.catalogEntryDynamic).toBeNull();

    const set = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: {
        dynamicProvider: "project_provider" as never,
        catalogEntryDiff: "mce_diff",
      },
      defaultSkill: SHIPPED_SKILL,
    });
    expect(set).toMatchObject({
      dynamicProvider: "project_provider",
      catalogEntryDiff: "mce_diff",
      catalogEntryDynamic: null,
      sources: {
        dynamicProvider: "project",
        catalogEntryDiff: "project",
        catalogEntryDynamic: "built_in",
      },
    });
  });

  // #430-T02
  it("keeps the provider of Diff and of Dynamic apart, like their models", () => {
    const project = {
      provider: "diff_provider" as never,
      dynamicProvider: "dynamic_provider" as never,
    };
    expect(resolveReviewSettings({ builtIn, project }).settings.provider).toBe(
      "diff_provider",
    );
    expect(
      resolveProjectDynamicSettings({
        builtIn: builtInProjectDynamicSettings(),
        project,
        defaultSkill: SHIPPED_SKILL,
      }).dynamicProvider,
    ).toBe("dynamic_provider");
  });

  // #430-T03
  it("resolves settings stored before the provider existed to the default provider", () => {
    const legacy = {
      model: "qwen/qwen3-coder",
      maxFindings: 4,
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    };

    const review = resolveReviewSettings({
      builtIn,
      project: parseStoredOverrides(legacy),
    });
    const dynamic = resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      project: parseStoredProjectDynamicOverrides(legacy),
      defaultSkill: SHIPPED_SKILL,
    });

    expect(review.settings.provider).toBe(DEFAULT_LLM_PROVIDER);
    expect(review.settings.model).toBe("qwen/qwen3-coder");
    expect(review.sources.provider).toBe("built_in");
    expect(dynamic.dynamicProvider).toBe(DEFAULT_LLM_PROVIDER);
    expect(dynamic.catalogEntryDiff).toBeNull();
    expect(dynamic.catalogEntryDynamic).toBeNull();
  });
});

describe("the workspace default of the kind, the Dynamic model and the verdict (#676)", () => {
  const resolve = (
    layers: Partial<Parameters<typeof resolveProjectDynamicSettings>[0]>,
  ) =>
    resolveProjectDynamicSettings({
      builtIn: builtInProjectDynamicSettings(),
      defaultSkill: SHIPPED_SKILL,
      ...layers,
    });

  // #676-T02
  it("is used by a project that sets nothing, and says so as its source", () => {
    const dynamic = resolve({
      workspace: {
        reviewKind: "dynamic",
        dynamicProvider: "anthropic",
        dynamicModel: "claude-sonnet",
        catalogEntryDynamic: "mce_ws",
        reviewVerdict: "any",
      },
      project: {},
    });

    expect(dynamic).toMatchObject({
      reviewKind: "dynamic",
      dynamicProvider: "anthropic",
      dynamicModel: "claude-sonnet",
      catalogEntryDynamic: "mce_ws",
      reviewVerdict: "any",
    });
    expect(dynamic.sources).toMatchObject({
      reviewKind: "global",
      dynamicProvider: "global",
      dynamicModel: "global",
      catalogEntryDynamic: "global",
      reviewVerdict: "global",
      // Nothing set anywhere: the shipped value.
      catalogEntryDiff: "built_in",
    });
  });

  // #676-T02
  it("loses to the project field by field, and the project's source is the project", () => {
    const dynamic = resolve({
      workspace: {
        reviewKind: "dynamic",
        dynamicModel: "workspace-model",
        reviewVerdict: "any",
      },
      project: { reviewKind: "diff", dynamicModel: "project-model" },
    });

    expect(dynamic.reviewKind).toBe("diff");
    expect(dynamic.dynamicModel).toBe("project-model");
    // The verdict is not overridden: the workspace default still applies.
    expect(dynamic.reviewVerdict).toBe("any");
    expect(dynamic.sources).toMatchObject({
      reviewKind: "project",
      dynamicModel: "project",
      reviewVerdict: "global",
    });
  });

  // #676-T02
  it("falls back to the shipped values when neither layer sets a field", () => {
    const dynamic = resolve({ workspace: {}, project: {} });

    expect(dynamic).toMatchObject({
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      reviewVerdict: "blocking",
    });
    expect(Object.values(dynamic.sources)).toEqual(
      Object.values(dynamic.sources).map(() => "built_in"),
    );
  });

  // #676 decision: the skill stays a project's
  it("never gives a project the skill of a workspace layer: the skill is the project's or the shipped one", () => {
    const smuggled = {
      reviewSkill: "a skill from the workspace",
    } as never;

    const dynamic = resolve({ workspace: smuggled, project: {} });

    expect(dynamic.reviewSkill).toBe(SHIPPED_SKILL);
    expect(dynamic.reviewSkillIsDefault).toBe(true);
    expect(dynamic.sources.reviewSkill).toBe("built_in");
  });
});
