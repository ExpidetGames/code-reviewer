// SPDX-License-Identifier: Apache-2.0

// Pins down the logic behind the settings form without a browser: how the saved settings become
// form values, how the values become the request (only the fields the person set), and which problem
// each wrong value gets. A problem is a field and a stable code; the sentence is the form's job.
import { describe, expect, it } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { builtInReviewSettings } from "../settings.ts";
import type { SettingsFormModel } from "./form-model.ts";
import {
  buildPatch,
  initialFormState,
  previewSettings,
  resetField,
  setBoolean,
  setCommand,
  setText,
} from "./form-state.ts";

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");

function model(
  overrides: SettingsFormModel["overrides"] = {},
  dynamic?: SettingsFormModel["dynamic"],
): SettingsFormModel {
  const effective = { ...BUILT_IN, ...overrides };
  return {
    mode: "project",
    inherited: BUILT_IN,
    overrides,
    effective,
    sources: {
      model: "built_in",
      fallbackModel: "built_in",
      extraInstructions: "built_in",
      maxFindings: "built_in",
      maxTokens: "built_in",
      largePrChunking: "built_in",
      inlineKeyIssues: "built_in",
      autoReviewOnOpen: "built_in",
      autoReviewOnPush: "built_in",
      allowedCommands: "built_in",
      modelTier: "built_in",
    },
    cost: estimateReviewCost(effective),
    managed: false,
    tierAvailability: null,
    lastSaved: null,
    ...(dynamic === undefined ? {} : { dynamic }),
  };
}

describe("the form values", () => {
  it("start from the settings in force, with no field marked as set by the person", () => {
    const state = initialFormState(model());

    expect(state.values.maxFindings).toBe("5");
    expect(state.values.model).toBe("anthropic/claude-haiku-5.5");
    expect(state.values.fallbackModel).toBe("");
    expect(Object.values(state.overridden).every((set) => !set)).toBe(true);
  });

  it("mark the fields that are overridden", () => {
    const state = initialFormState(model({ maxFindings: 9 }));

    expect(state.overridden.maxFindings).toBe(true);
    expect(state.overridden.maxTokens).toBe(false);
    expect(state.values.maxFindings).toBe("9");
  });

  it("mark a field as set as soon as the person changes it, even back to the inherited value", () => {
    let state = initialFormState(model());

    state = setText(state, "maxFindings", "5");

    expect(state.overridden.maxFindings).toBe(true);
  });

  it("go back to the inherited value and stop counting as set when the person resets a field", () => {
    const m = model({ maxFindings: 9 });
    let state = initialFormState(m);

    state = resetField(state, "maxFindings", m);

    expect(state.overridden.maxFindings).toBe(false);
    expect(state.values.maxFindings).toBe("5");
  });

  it("toggle the review command and keep the list in the canonical order", () => {
    let state = initialFormState(model({ allowedCommands: [] }));

    state = setCommand(state, "review", true);

    expect(state.values.allowedCommands).toEqual(["review"]);
    expect(state.overridden.allowedCommands).toBe(true);

    state = setCommand(state, "review", false);

    expect(state.values.allowedCommands).toEqual([]);
  });
});

describe("the model tier in the form", () => {
  // #280-T10
  it("is carried through a save: a stored tier is sent back, and none is sent when it was never set", () => {
    const stored = initialFormState(model({ modelTier: "high" }));
    const unset = initialFormState(model());

    expect(stored.values.modelTier).toBe("high");
    expect(buildPatch(stored)).toEqual({
      ok: true,
      patch: { modelTier: "high" },
    });
    expect(buildPatch(unset)).toEqual({ ok: true, patch: {} });
  });
});

describe("the request built from the form", () => {
  it("holds only the fields the person set, as typed values", () => {
    let state = initialFormState(model());
    state = setText(state, "maxFindings", " 12 ");
    state = setBoolean(state, "inlineKeyIssues", true);
    state = setText(state, "fallbackModel", "openai/gpt-5.4-mini");

    const result = buildPatch(state);

    expect(result).toEqual({
      ok: true,
      patch: {
        maxFindings: 12,
        inlineKeyIssues: true,
        fallbackModel: "openai/gpt-5.4-mini",
      },
    });
  });

  it("holds nothing when nothing is set, which makes the layer inherit everything", () => {
    expect(buildPatch(initialFormState(model()))).toEqual({
      ok: true,
      patch: {},
    });
  });

  it("sends an emptied fallback model as none", () => {
    let state = initialFormState(
      model({ fallbackModel: "openai/gpt-5.4-mini" }),
    );
    state = setText(state, "fallbackModel", "");

    expect(buildPatch(state)).toEqual({
      ok: true,
      patch: { fallbackModel: "" },
    });
  });

  // CR-34-T06
  it.each([
    ["-3", "TOO_SMALL"],
    ["0", "TOO_SMALL"],
    ["31", "TOO_LARGE"],
    ["abc", "INVALID_TYPE"],
    ["1.5", "INVALID_TYPE"],
    ["1e3", "INVALID_TYPE"],
    ["", "EMPTY"],
    ["   ", "EMPTY"],
  ])("reports %j for the number of findings as %s", (typed, code) => {
    const state = setText(initialFormState(model()), "maxFindings", typed);

    expect(buildPatch(state)).toEqual({
      ok: false,
      issues: [{ field: "maxFindings", code }],
    });
  });

  // CR-34-T06
  it("reports a model name that is empty or not a name", () => {
    const empty = buildPatch(setText(initialFormState(model()), "model", "  "));
    const bad = buildPatch(
      setText(initialFormState(model()), "model", "has space"),
    );

    expect(empty).toEqual({
      ok: false,
      issues: [{ field: "model", code: "EMPTY" }],
    });
    expect(bad).toEqual({
      ok: false,
      issues: [{ field: "model", code: "INVALID_FORMAT" }],
    });
  });

  // CR-34-T06
  it("reports project rules that are too long", () => {
    const state = setText(
      initialFormState(model()),
      "extraInstructions",
      "x".repeat(4001),
    );

    expect(buildPatch(state)).toEqual({
      ok: false,
      issues: [{ field: "extraInstructions", code: "TOO_LONG" }],
    });
  });

  // CR-34-T06
  it("reports every wrong field at once", () => {
    let state = initialFormState(model());
    state = setText(state, "maxFindings", "-1");
    state = setText(state, "maxTokens", "many");
    state = setText(state, "model", "");

    const result = buildPatch(state);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.field).sort()).toEqual([
        "maxFindings",
        "maxTokens",
        "model",
      ]);
  });

  it("does not check a field the person did not set, even if it would be wrong", () => {
    const state = initialFormState(model());
    state.values.maxFindings = "nonsense";

    expect(buildPatch(state)).toEqual({ ok: true, patch: {} });
  });
});

describe("the preview of the cost", () => {
  it("applies the values the person set on top of the inherited settings", () => {
    let state = initialFormState(model());
    state = setText(state, "model", "anthropic/claude-sonnet-5.5");

    const preview = previewSettings(model(), state);

    expect(preview?.model).toBe("anthropic/claude-sonnet-5.5");
    expect(preview?.maxFindings).toBe(5);
  });

  it("is not available while a value is wrong", () => {
    const state = setText(initialFormState(model()), "maxTokens", "abc");

    expect(previewSettings(model(), state)).toBeNull();
  });
});

// #194-T06: the form does not send the project-only settings it does not edit. The server keeps the
// stored ones a request does not mention, so a stale form cannot overwrite a newer kind/model/skill.
describe("the project-only settings in the form serialization", () => {
  const dynamic = {
    overrides: {
      reviewKind: "dynamic" as const,
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "review for the Dynamic kind",
    },
    effective: {
      reviewKind: "dynamic" as const,
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "review for the Dynamic kind",
    },
    sources: {
      reviewKind: "project" as const,
      dynamicModel: "project" as const,
      reviewSkill: "project" as const,
    },
    defaults: {
      reviewKind: "diff" as const,
      dynamicModel: "deepseek/deepseek-v4.1-flash",
      reviewSkill: "shipped skill",
    },
    reviewSkillIsDefault: false,
    defaultSkill: {
      id: "codex-review-skill",
      version: "v1",
      hash: "hash",
    },
    limits: { reviewSkillMaxBytes: 16_384 },
  };

  it("stay out of the save, so a stale form cannot overwrite a newer value", () => {
    let state = initialFormState(model({ maxFindings: 9 }, dynamic));
    state = setText(state, "maxFindings", "12");

    expect(buildPatch(state)).toEqual({
      ok: true,
      patch: { maxFindings: 12 },
    });
  });

  it("stay out of the estimate of the Diff review", () => {
    const m = model({ maxFindings: 9 }, dynamic);
    const state = initialFormState(m);

    expect(previewSettings(m, state)?.maxFindings).toBe(9);
  });
});
