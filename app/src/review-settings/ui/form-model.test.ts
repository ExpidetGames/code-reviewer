// SPDX-License-Identifier: Apache-2.0

// How the answer of a settings route becomes the model of the form, for a workspace on the operator's key (#283) and
// for one that is not, including the answer of a server of the release before the quality choice.
import { describe, expect, it } from "vitest";
import { modelFromAnswer } from "./form-model.ts";
import { buildPatch, initialFormState, previewSettings } from "./form-state.ts";
import { builtInReviewSettings, withoutModelFields } from "../settings.ts";
import { estimateReviewCost } from "../cost.ts";

const BUILT_IN = builtInReviewSettings("vendor/some-model");
const SOURCES = Object.fromEntries(
  Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
);

function globalAnswer(extra: Record<string, unknown>) {
  return {
    overrides: {},
    effective: BUILT_IN,
    sources: SOURCES,
    cost: estimateReviewCost(BUILT_IN),
    builtIn: BUILT_IN,
    updatedAt: null,
    updatedBy: null,
    ...extra,
  };
}

describe("the form model of an answer", () => {
  // #283-T01
  it("is managed when the answer says so, with no cost", () => {
    const readable = withoutModelFields(BUILT_IN);

    const model = modelFromAnswer(
      "global",
      globalAnswer({
        effective: readable,
        builtIn: readable,
        cost: null,
        modelManagedByInstance: true,
      }),
    );

    expect(model).toMatchObject({ managed: true, cost: null, catalog: null });
  });

  // #283-T02
  it("is not managed for the answer of a server that does not know the flag", () => {
    const model = modelFromAnswer("global", globalAnswer({}));

    expect(model).toMatchObject({ managed: false, catalog: null });
    expect(model?.cost).not.toBeNull();
  });

  // #283-T01
  it("makes a form that has no model value, offers no estimate and sends nothing by itself", () => {
    const readable = withoutModelFields(BUILT_IN);
    const model = modelFromAnswer(
      "global",
      globalAnswer({
        effective: readable,
        builtIn: readable,
        cost: null,
        modelManagedByInstance: true,
      }),
    );
    if (model === null) throw new Error("no model");

    const state = initialFormState(model);

    expect(previewSettings(model, state)).toBeNull();
    expect(buildPatch(state)).toEqual({ ok: true, patch: {} });
  });

  // #433-T02
  it("carries the catalog view of a project on the operator's key, entries and selection, and nothing else", () => {
    const readable = withoutModelFields(BUILT_IN);
    const choices = {
      diff: [
        {
          id: "ent-1",
          name: "Quick look",
          description: null,
          available: true,
          reason: null,
        },
      ],
      dynamic: [],
    };
    const selection = { diff: "ent-1", dynamic: null };

    const model = modelFromAnswer("project", {
      ...globalAnswer({
        effective: readable,
        cost: null,
        modelManagedByInstance: true,
      }),
      inherited: readable,
      dynamic: { effective: { reviewKind: "diff" } },
      catalogChoices: choices,
      catalogSelection: selection,
    });

    expect(model?.managed).toBe(true);
    expect(model?.catalog).toEqual({ choices, selection });
  });

  // #433-T02
  it("has no catalog for a project on its own key, nor for the answer of a server that does not know it", () => {
    const own = {
      ...globalAnswer({}),
      inherited: BUILT_IN,
      dynamic: { effective: { reviewKind: "diff" } },
    };

    expect(modelFromAnswer("project", own)?.catalog).toBeNull();
    expect(
      modelFromAnswer("project", {
        ...own,
        catalogChoices: null,
        catalogSelection: null,
      })?.catalog,
    ).toBeNull();
  });

  it("is refused for an answer without the parts of a view", () => {
    expect(modelFromAnswer("global", { effective: {} })).toBeNull();
    expect(modelFromAnswer("global", null)).toBeNull();
  });
});
