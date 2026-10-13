// SPDX-License-Identifier: Apache-2.0

// Pins down how a project form becomes requests (#200): a save that changed nothing sends nothing, only
// the changed groups are sent, the Diff group is replaced as a whole and reset explicitly, and the skill
// is reset with `null`. The project-only fields (kind, Dynamic model, skill) are sent only when the person
// changed them, so a stale form cannot overwrite a newer value (#194-T06).
import { describe, expect, it } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../default-skill.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
} from "../settings.ts";
import type { ProjectDynamicView } from "../service.ts";
import type { SettingsFormModel } from "./form-model.ts";
import {
  initialFormState,
  setBoolean,
  setText,
  resetField,
} from "./form-state.ts";
import {
  editSkill,
  resetSkill,
  setDynamicModel,
  setReviewKind,
  setSkillText,
  skillByteLength,
} from "./dynamic-form-state.ts";
import { adoptCards, planProjectSave } from "./project-save.ts";

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const SHIPPED = DEFAULT_REVIEW_SKILL.text;

function dynamicView(
  overrides: ProjectDynamicView["overrides"] = {},
): ProjectDynamicView {
  const kind = overrides.reviewKind ?? "diff";
  const skill = overrides.reviewSkill ?? SHIPPED;
  return {
    overrides,
    effective: {
      reviewKind: kind,
      dynamicModel: overrides.dynamicModel ?? DEFAULT_DYNAMIC_MODEL,
      reviewSkill: skill,
    },
    sources: {
      reviewKind: overrides.reviewKind === undefined ? "built_in" : "project",
      dynamicModel:
        overrides.dynamicModel === undefined ? "built_in" : "project",
      reviewSkill: overrides.reviewSkill === undefined ? "built_in" : "project",
    },
    defaults: {
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      reviewSkill: SHIPPED,
    },
    reviewSkillIsDefault: overrides.reviewSkill === undefined,
    defaultSkill: {
      id: DEFAULT_REVIEW_SKILL.id,
      version: DEFAULT_REVIEW_SKILL.version,
      hash: DEFAULT_REVIEW_SKILL.hash,
    },
    limits: { reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes },
  };
}

function model(
  overrides: SettingsFormModel["overrides"] = {},
  dynamic: ProjectDynamicView = dynamicView(),
): SettingsFormModel {
  const effective = { ...BUILT_IN, ...overrides };
  return {
    mode: "project",
    inherited: BUILT_IN,
    overrides,
    effective,
    sources: Object.fromEntries(
      Object.keys(effective).map((field) => [
        field,
        Object.hasOwn(overrides, field) ? "project" : "built_in",
      ]),
    ) as SettingsFormModel["sources"],
    cost: estimateReviewCost(effective),
    lastSaved: null,
    dynamic,
  };
}

function plan(m: SettingsFormModel, state = initialFormState(m)) {
  const result = planProjectSave(m, state);
  if (!result.ok)
    throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
  return result;
}

// #200-T01, lead note (1)
describe("a project save that changed nothing", () => {
  it("sends no request at all, not even an empty one", () => {
    expect(plan(model()).steps).toEqual([]);
    expect(plan(model({ maxFindings: 9 })).steps).toEqual([]);
  });

  it("sends no request when a changed value was typed back to what it was", () => {
    const m = model({ maxFindings: 9 });
    let state = initialFormState(m);
    state = setText(state, "maxFindings", "12");
    state = setText(state, "maxFindings", "9");

    expect(plan(m, state).steps).toEqual([]);
  });

  it("sends nothing when the shipped skill text is edited back to the shipped default text", () => {
    const m = model();
    let state = editSkill(initialFormState(m), SHIPPED);
    state = setSkillText(state, `${SHIPPED}\nextra`);
    state = setSkillText(state, SHIPPED);

    expect(plan(m, state).steps).toEqual([]);
  });
});

// #200-T01, lead note (2)
describe("a project save that changed only the project-only settings", () => {
  it("sends the review kind alone and leaves the Diff group out, so the server keeps it", () => {
    const m = model({ maxFindings: 9 });
    const state = setReviewKind(initialFormState(m), "dynamic");

    const result = plan(m, state);

    expect(result.steps).toEqual([
      { cards: ["kind"], body: { reviewKind: "dynamic" } },
    ]);
    expect(result.kindChange).toEqual({ from: "diff", to: "dynamic" });
  });

  it("keeps the edits and the model of the other kind while the kind is toggled back and forth", () => {
    const m = model();
    let state = setReviewKind(initialFormState(m), "dynamic");
    state = setDynamicModel(state, "vendor/agent-1");
    state = setReviewKind(state, "diff");
    state = setText(state, "model", "openai/gpt-5.4-mini");
    state = setReviewKind(state, "dynamic");

    expect(state.dynamic?.dynamicModel).toBe("vendor/agent-1");
    expect(state.values.model).toBe("openai/gpt-5.4-mini");
    expect(plan(m, state).steps).toEqual([
      {
        cards: ["diff", "kind"],
        body: {
          model: "openai/gpt-5.4-mini",
          reviewKind: "dynamic",
          dynamicModel: "vendor/agent-1",
        },
      },
    ]);
  });

  it("sends the Dynamic model as typed once it differs from the one in force, trimmed", () => {
    const m = model();
    const state = setDynamicModel(initialFormState(m), "  vendor/agent-1 ");

    expect(plan(m, state).steps).toEqual([
      { cards: ["kind"], body: { dynamicModel: "vendor/agent-1" } },
    ]);
  });

  it("does not send the Dynamic model when it is the default that was typed again", () => {
    const m = model();
    const state = setDynamicModel(initialFormState(m), DEFAULT_DYNAMIC_MODEL);

    expect(plan(m, state).steps).toEqual([]);
  });

  it("has no kind change to confirm when the kind stays", () => {
    const m = model({}, dynamicView({ reviewKind: "dynamic" }));
    const state = setDynamicModel(initialFormState(m), "vendor/agent-1");

    expect(plan(m, state).kindChange).toBeNull();
  });
});

// #200-T02, lead note (3)
describe("the review skill in a save", () => {
  it("sends the edited text as an override", () => {
    const m = model();
    let state = editSkill(initialFormState(m), SHIPPED);
    state = setSkillText(state, "Review only security issues.");

    expect(plan(m, state).steps).toEqual([
      {
        cards: ["kind"],
        body: { reviewSkill: "Review only security issues." },
      },
    ]);
  });

  it("stages the reset until the save and sends null for it, which is what removes an override", () => {
    const m = model({}, dynamicView({ reviewSkill: "My own skill" }));
    const state = resetSkill(initialFormState(m), SHIPPED);

    expect(state.dynamic?.skillMode).toBe("default");
    expect(plan(m, state).steps).toEqual([
      { cards: ["kind"], body: { reviewSkill: null } },
    ]);
  });

  it("sends nothing for a reset when the project has no override to remove", () => {
    const m = model();
    const state = resetSkill(editSkill(initialFormState(m), SHIPPED), SHIPPED);

    expect(plan(m, state).steps).toEqual([]);
  });

  it("does not store a copy of the shipped text as an override", () => {
    const m = model({}, dynamicView({ reviewSkill: "My own skill" }));
    const state = setSkillText(initialFormState(m), SHIPPED);

    expect(plan(m, state).steps).toEqual([
      { cards: ["kind"], body: { reviewSkill: null } },
    ]);
  });

  it("keeps the custom text of a reset until the save, so Edit skill brings it back", () => {
    const m = model({}, dynamicView({ reviewSkill: "My own skill" }));
    let state = setSkillText(initialFormState(m), "My edited skill");
    state = resetSkill(state, SHIPPED);

    expect(state.dynamic?.skillText).toBe(SHIPPED);
    expect(state.dynamic?.draft).toBe("My edited skill");
    state = editSkill(state, SHIPPED);
    expect(state.dynamic?.skillText).toBe("My edited skill");
    expect(state.dynamic?.draft).toBeNull();
    expect(plan(m, state).steps).toEqual([
      { cards: ["kind"], body: { reviewSkill: "My edited skill" } },
    ]);
  });

  it("counts the bytes of the text, not its characters", () => {
    expect(skillByteLength("abc")).toBe(3);
    expect(skillByteLength("ä")).toBe(2);
    expect(skillByteLength("日本")).toBe(6);
    expect(skillByteLength("😀")).toBe(4);
  });

  // #200-T03
  it("refuses an empty custom skill instead of quietly resetting it", () => {
    const m = model();
    let state = editSkill(initialFormState(m), SHIPPED);
    state = setSkillText(state, "  \n ");

    expect(planProjectSave(m, state)).toEqual({
      ok: false,
      issues: [{ field: "reviewSkill", code: "EMPTY" }],
    });
  });

  // #200-T03
  it("refuses a skill whose UTF-8 bytes are over the limit even though its characters are not", () => {
    const m = model();
    let state = editSkill(initialFormState(m), SHIPPED);
    // 6,000 characters, 18,000 bytes.
    state = setSkillText(state, "日".repeat(6000));

    expect(planProjectSave(m, state)).toEqual({
      ok: false,
      issues: [{ field: "reviewSkill", code: "TOO_LONG" }],
    });
  });

  // #200-T03
  it("refuses control characters in a skill and an invalid Dynamic model, each at its field", () => {
    const m = model();
    let state = editSkill(initialFormState(m), SHIPPED);
    state = setSkillText(state, "bad\u0000text");
    state = setDynamicModel(state, "has space");

    const result = planProjectSave(m, state);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { field: "reviewSkill", code: "FORBIDDEN_CHARACTERS" },
        { field: "dynamicModel", code: "INVALID_FORMAT" },
      ]),
    );
  });

  // #200-T03
  it("refuses an emptied Dynamic model", () => {
    const m = model();
    const state = setDynamicModel(initialFormState(m), "   ");

    expect(planProjectSave(m, state)).toEqual({
      ok: false,
      issues: [{ field: "dynamicModel", code: "EMPTY" }],
    });
  });
});

// #200-T02, lead note (2)
describe("the Diff group in a project save", () => {
  it("sends the whole set of the Diff overrides together with the project-only fields in one request", () => {
    const m = model({ maxFindings: 9 });
    let state = initialFormState(m);
    state = setBoolean(state, "inlineKeyIssues", true);
    state = setReviewKind(state, "dynamic");

    expect(plan(m, state).steps).toEqual([
      {
        cards: ["diff", "kind"],
        body: { maxFindings: 9, inlineKeyIssues: true, reviewKind: "dynamic" },
      },
    ]);
  });

  it("resets the Diff group explicitly with an empty request when every override was taken back", () => {
    const m = model({ maxFindings: 9 });
    const state = resetField(initialFormState(m), "maxFindings", m);

    expect(plan(m, state).steps).toEqual([{ cards: ["diff"], body: {} }]);
  });

  it("resets the Diff group first and then sends the project-only fields, because one request cannot do both", () => {
    const m = model({ maxFindings: 9 });
    let state = resetField(initialFormState(m), "maxFindings", m);
    state = setReviewKind(state, "dynamic");

    expect(plan(m, state).steps).toEqual([
      { cards: ["diff"], body: {} },
      { cards: ["kind"], body: { reviewKind: "dynamic" } },
    ]);
  });

  it("names the problems of a Diff field that is hidden by the other kind", () => {
    const m = model();
    let state = setText(initialFormState(m), "maxFindings", "abc");
    state = setReviewKind(state, "dynamic");

    expect(planProjectSave(m, state)).toEqual({
      ok: false,
      issues: [{ field: "maxFindings", code: "INVALID_TYPE" }],
    });
  });
});

describe("taking the answer of a partial save", () => {
  it("replaces only the saved cards and keeps what the person typed in the others", () => {
    const m = model({ maxFindings: 9 });
    let state = resetField(initialFormState(m), "maxFindings", m);
    state = setReviewKind(state, "dynamic");
    const saved = model({}, dynamicView());

    const next = adoptCards(state, saved, ["diff"]);

    expect(next.values.maxFindings).toBe("5");
    expect(next.overridden.maxFindings).toBe(false);
    expect(next.dynamic?.reviewKind).toBe("dynamic");
  });
});
