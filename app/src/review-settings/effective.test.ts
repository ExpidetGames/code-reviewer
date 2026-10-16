// SPDX-License-Identifier: Apache-2.0

// Pins down how the layers (built-in values, global defaults, project overrides) become the settings
// of one review, and what the switches for triggers and commands mean.
import { describe, expect, it } from "vitest";
import {
  isAutomaticReviewEnabled,
  isCommandAllowed,
  resolveProjectDynamicSettings,
  resolveReviewSettings,
} from "./effective.ts";
import { MODEL_PRICES } from "./model-pricing.ts";
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

describe("the model tier setting", () => {
  // #280-T10
  it("is medium when nothing sets it", () => {
    expect(builtIn.modelTier).toBe("medium");
    expect(resolveReviewSettings({ builtIn }).settings.modelTier).toBe(
      "medium",
    );
  });

  // #280-T10
  it("follows the workspace default, and the project's own tier wins over it", () => {
    const global = resolveReviewSettings({
      builtIn,
      global: { modelTier: "low" },
    });
    const project = resolveReviewSettings({
      builtIn,
      global: { modelTier: "low" },
      project: { modelTier: "high" },
    });

    expect(global.settings.modelTier).toBe("low");
    expect(global.sources.modelTier).toBe("global");
    expect(project.settings.modelTier).toBe("high");
    expect(project.sources.modelTier).toBe("project");
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
    expect(dynamic.sources).toEqual({
      reviewKind: "built_in",
      dynamicModel: "built_in",
      reviewSkill: "built_in",
    });
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
