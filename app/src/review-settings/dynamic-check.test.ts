// SPDX-License-Identifier: Apache-2.0

// Which Dynamic model a project save has to ask the provider about, and at which provider (#430): the model is only
// meaningful at the provider it belongs to, so the check follows the provider the project selected.
import { describe, expect, it } from "vitest";
import { dynamicModelToCheck } from "./dynamic-check.ts";

const DEFAULT = "openrouter";

describe("the Dynamic model a save asks the provider about", () => {
  // #430-T11
  it("is the model of the request, at the provider of the request", () => {
    expect(
      dynamicModelToCheck(
        { dynamicModel: "fake-large", dynamicProvider: "fakeai" as never },
        { dynamicModel: "stored/model", dynamicProvider: "stored_provider" },
        DEFAULT,
      ),
    ).toEqual({ model: "fake-large", provider: "fakeai" });
  });

  // #430-T11
  it("is at the stored provider when the request names only the model", () => {
    expect(
      dynamicModelToCheck(
        { dynamicModel: "fake-large" },
        { dynamicProvider: "fakeai" },
        DEFAULT,
      ),
    ).toEqual({ model: "fake-large", provider: "fakeai" });
  });

  // #430-T11
  it("is at the default provider when neither the request nor the project names one", () => {
    expect(
      dynamicModelToCheck({ dynamicModel: "vendor/model" }, {}, DEFAULT),
    ).toEqual({ model: "vendor/model", provider: DEFAULT });
    // A request that clears the provider means the default again.
    expect(
      dynamicModelToCheck(
        { dynamicModel: "vendor/model", dynamicProvider: null },
        { dynamicProvider: "fakeai" },
        DEFAULT,
      ),
    ).toEqual({ model: "vendor/model", provider: DEFAULT });
  });

  // #430-T11
  it("is the stored model again at the new provider when only the provider changes", () => {
    expect(
      dynamicModelToCheck(
        { dynamicProvider: "fakeai" as never },
        { dynamicModel: "stored-model" },
        DEFAULT,
      ),
    ).toEqual({ model: "stored-model", provider: "fakeai" });
    // Clearing the provider moves the stored model back to the default provider, which has to vouch for it.
    expect(
      dynamicModelToCheck(
        { dynamicProvider: null },
        { dynamicModel: "x/y", dynamicProvider: "fakeai" },
        DEFAULT,
      ),
    ).toEqual({ model: "x/y", provider: DEFAULT });
  });

  // #430-T11
  it("is nothing when the request names no model and no provider, or clears the model", () => {
    expect(
      dynamicModelToCheck({}, { dynamicModel: "x/y" }, DEFAULT),
    ).toBeNull();
    expect(
      dynamicModelToCheck(
        { dynamicModel: null },
        { dynamicProvider: "fakeai" },
        DEFAULT,
      ),
    ).toBeNull();
    // A provider change without any model stored has nothing to check: the provider's own default applies.
    expect(
      dynamicModelToCheck({ dynamicProvider: "fakeai" as never }, {}, DEFAULT),
    ).toBeNull();
  });
});
