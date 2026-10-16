// SPDX-License-Identifier: Apache-2.0

// How the answer of a settings route becomes the model of the form, for a workspace on the operator's key (#283) and
// for one that is not, including the answer of a server of the release before the quality choice.
import { describe, expect, it } from "vitest";
import { modelFromAnswer } from "./form-model.ts";
import {
  buildPatch,
  initialFormState,
  previewSettings,
  setModelTier,
} from "./form-state.ts";
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
  it("is managed when the answer says so, with no cost and the availability of the levels", () => {
    const readable = withoutModelFields(BUILT_IN);
    const availability = {
      low: { diff: true, dynamic: true },
      medium: { diff: true, dynamic: false },
      high: { diff: false, dynamic: false },
    };

    const model = modelFromAnswer(
      "global",
      globalAnswer({
        effective: readable,
        builtIn: readable,
        cost: null,
        modelManagedByInstance: true,
        tierAvailability: availability,
      }),
    );

    expect(model).toMatchObject({
      managed: true,
      cost: null,
      tierAvailability: availability,
    });
  });

  // #283-T02
  it("is not managed for the answer of a server that does not know the flag", () => {
    const model = modelFromAnswer("global", globalAnswer({}));

    expect(model).toMatchObject({ managed: false, tierAvailability: null });
    expect(model?.cost).not.toBeNull();
  });

  // #283-T01
  it("makes a form that has no model value, offers no estimate and sends only the level chosen", () => {
    const readable = withoutModelFields(BUILT_IN);
    const model = modelFromAnswer(
      "global",
      globalAnswer({
        effective: readable,
        builtIn: readable,
        cost: null,
        modelManagedByInstance: true,
        tierAvailability: null,
      }),
    );
    if (model === null) throw new Error("no model");

    const state = setModelTier(initialFormState(model), "high");

    expect(previewSettings(model, state)).toBeNull();
    expect(buildPatch(state)).toEqual({
      ok: true,
      patch: { modelTier: "high" },
    });
  });

  it("is refused for an answer without the parts of a view", () => {
    expect(modelFromAnswer("global", { effective: {} })).toBeNull();
    expect(modelFromAnswer("global", null)).toBeNull();
  });
});
