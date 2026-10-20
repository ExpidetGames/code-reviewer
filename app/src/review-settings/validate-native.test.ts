// SPDX-License-Identifier: Apache-2.0

// The Dynamic provider of a project can be a catalog provider (#555); the Diff provider cannot until #558. Pure checks of the
// shape: whether the model is in the catalog is the service's question.
import { describe, expect, it } from "vitest";
import {
  parseStoredProjectDynamicOverrides,
  validateProjectSettingsPatch,
  validateReviewSettingsPatch,
} from "./validate.ts";

describe("a catalog provider in the settings of a project", () => {
  // #555-T01
  it("is accepted as the Dynamic provider, by its slug", () => {
    expect(
      validateProjectSettingsPatch({
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
      }),
    ).toEqual({
      ok: true,
      value: {
        review: {},
        dynamic: {
          dynamicProvider: "deepseek",
          dynamicModel: "deepseek-v4-pro",
        },
      },
    });
    expect(
      validateProjectSettingsPatch({ dynamicProvider: "  DeepSeek " }),
    ).toMatchObject({
      ok: true,
      value: { dynamic: { dynamicProvider: "deepseek" } },
    });
  });

  // #555-T01
  it("is refused as the Diff provider: the Diff model keeps its providers until #558", () => {
    expect(
      validateProjectSettingsPatch({ provider: "deepseek", model: "m" }),
    ).toEqual({
      ok: false,
      issues: [{ field: "provider", code: "PROVIDER_UNKNOWN" }],
    });
    expect(validateReviewSettingsPatch({ provider: "deepseek" })).toEqual({
      ok: false,
      issues: [{ field: "provider", code: "PROVIDER_UNKNOWN" }],
    });
  });

  // #555-T01
  it("is refused when it is excluded, unknown or no slug", () => {
    for (const dynamicProvider of [
      "amazon_bedrock",
      "google_vertex",
      "nosuchprovider",
      "fireworks-ai",
    ])
      expect(validateProjectSettingsPatch({ dynamicProvider })).toEqual({
        ok: false,
        issues: [{ field: "dynamicProvider", code: "PROVIDER_UNKNOWN" }],
      });
  });

  // #555-T04
  it("takes a model id of the shape the job entry carries, and nothing else", () => {
    expect(
      validateProjectSettingsPatch({
        dynamicProvider: "fireworks_ai",
        dynamicModel: "accounts/fireworks/models/x-1.5",
      }).ok,
    ).toBe(true);
    for (const dynamicModel of ["has space", "a..b", "-lead", "x".repeat(201)])
      expect(
        validateProjectSettingsPatch({
          dynamicProvider: "deepseek",
          dynamicModel,
        }),
      ).toEqual({
        ok: false,
        issues: [{ field: "dynamicModel", code: "INVALID_FORMAT" }],
      });
  });

  // #555-T01
  it("is kept when a stored project is read, and dropped when the provider left the supported file", () => {
    expect(
      parseStoredProjectDynamicOverrides({
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
      }),
    ).toEqual({
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
    expect(
      parseStoredProjectDynamicOverrides({ dynamicProvider: "nosuchprovider" }),
    ).toEqual({});
  });
});
