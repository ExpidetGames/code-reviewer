// SPDX-License-Identifier: Apache-2.0

// Pins down how the form of the workspace defaults becomes a request (#676): one request that carries the whole set (every
// field that differs from the shipped value), nothing when nothing changed, an empty set to take a default back.
import { describe, expect, it } from "vitest";
import {
  dynamicView,
  managedModel,
  ownModel,
} from "../../test-support/settings-form-models.ts";
import type { SettingsFormModel } from "./form-model.ts";
import {
  setCatalogEntry,
  setDynamicModel,
  setDynamicProvider,
  setReviewKind,
  setReviewVerdict,
} from "./dynamic-form-state.ts";
import { setText, initialFormState } from "./form-state.ts";
import { planGlobalSave } from "./global-save.ts";

/** The saved defaults of a workspace on its own key that chose Dynamic Review on another model and verdict. */
function savedModel(): SettingsFormModel {
  const base = ownModel({ mode: "global" });
  const view = dynamicView("dynamic", false);
  return {
    ...base,
    dynamic: {
      ...view,
      overrides: {
        reviewKind: "dynamic",
        dynamicProvider: "anthropic",
        dynamicModel: "claude-sonnet-5-5",
        reviewVerdict: "any",
      },
      effective: {
        ...view.effective,
        reviewKind: "dynamic",
        dynamicProvider: "anthropic",
        dynamicModel: "claude-sonnet-5-5",
        reviewVerdict: "any",
      },
    },
  };
}

describe("a save of the workspace defaults", () => {
  // #676-T01
  it("sends nothing when nothing changed", () => {
    for (const model of [
      ownModel({ mode: "global" }),
      savedModel(),
      managedModel({ mode: "global" }),
    ])
      expect(planGlobalSave(model, initialFormState(model))).toEqual({
        ok: true,
        steps: [],
        kindChange: null,
      });
  });

  // #676-T01
  it("sends the kind that differs from the shipped one, and asks for the confirmation of the switch", () => {
    const model = ownModel({ mode: "global" });

    const plan = planGlobalSave(
      model,
      setReviewKind(initialFormState(model), "dynamic"),
    );

    expect(plan).toEqual({
      ok: true,
      steps: [{ cards: ["diff", "kind"], body: { reviewKind: "dynamic" } }],
      kindChange: { from: "diff", to: "dynamic" },
    });
  });

  // #676-T01
  it("sends the whole set: what is saved stays in the request, so a default is only dropped by leaving it out", () => {
    const model = savedModel();
    const state = setText(initialFormState(model), "maxFindings", "9");

    const plan = planGlobalSave(model, state);

    expect(plan).toMatchObject({
      ok: true,
      steps: [
        {
          body: {
            maxFindings: 9,
            reviewKind: "dynamic",
            dynamicProvider: "anthropic",
            dynamicModel: "claude-sonnet-5-5",
            reviewVerdict: "any",
          },
        },
      ],
      kindChange: null,
    });
  });

  // #676-T02
  it("takes a default back by leaving it out when the shipped value is chosen again", () => {
    const model = savedModel();
    let state = setReviewKind(initialFormState(model), "diff");
    state = setReviewVerdict(state, "blocking");
    state = setDynamicProvider(state, "openrouter");
    state = setDynamicModel(state, model.dynamic!.defaults.dynamicModel ?? "");

    expect(planGlobalSave(model, state)).toEqual({
      ok: true,
      steps: [{ cards: ["diff", "kind"], body: {} }],
      kindChange: { from: "dynamic", to: "diff" },
    });
  });

  // #676-T07
  it("names an empty Dynamic model, the way a project does, and sends nothing", () => {
    const model = ownModel({ mode: "global" });
    const state = setDynamicModel(initialFormState(model), "  ");

    expect(planGlobalSave(model, state)).toEqual({
      ok: false,
      issues: [{ field: "dynamicModel", code: "EMPTY" }],
    });
  });

  // #676-T01
  it("sends the catalog entries of a workspace on the operator's key, and neither a provider nor a model", () => {
    const model = managedModel({ mode: "global" });
    let state = setCatalogEntry(initialFormState(model), "diff", "ent-fast");
    state = setCatalogEntry(state, "dynamic", "ent-explorer");

    expect(planGlobalSave(model, state)).toMatchObject({
      ok: true,
      steps: [
        {
          body: {
            catalogEntryDiff: "ent-fast",
            catalogEntryDynamic: "ent-explorer",
          },
        },
      ],
    });
  });

  // #676-T01
  it("takes an entry back by leaving it out", () => {
    const model = managedModel({
      mode: "global",
      selection: { diff: "ent-fast", dynamic: null },
    });

    const unchanged = planGlobalSave(model, initialFormState(model));
    const taken = planGlobalSave(
      model,
      setCatalogEntry(initialFormState(model), "diff", null),
    );

    expect(unchanged).toMatchObject({ ok: true, steps: [] });
    expect(taken).toEqual({
      ok: true,
      steps: [{ cards: ["diff", "kind"], body: {} }],
      kindChange: null,
    });
  });
});
