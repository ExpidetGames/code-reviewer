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

describe("the address a project pins for its catalog provider (#588)", () => {
  // #588-T03
  it("is written by the server and never by a request: the field is unknown to a save", () => {
    expect(
      validateProjectSettingsPatch({
        dynamicProvider: "deepseek",
        dynamicProviderAddress: "https://attacker.example",
      }),
    ).toEqual({
      ok: false,
      issues: [{ field: "dynamicProviderAddress", code: "UNKNOWN_FIELD" }],
    });
  });

  // #588-T04
  it("is confirmed anew by a request that says so, and only by `true`", () => {
    expect(
      validateProjectSettingsPatch({ confirmProviderAddress: true }),
    ).toEqual({
      ok: true,
      value: { review: {}, dynamic: {}, confirmProviderAddress: true },
    });
    for (const value of [false, "true", 1, null])
      expect(
        validateProjectSettingsPatch({ confirmProviderAddress: value }),
      ).toEqual({
        ok: false,
        issues: [{ field: "confirmProviderAddress", code: "INVALID_TYPE" }],
      });
  });

  // #588-T05
  it("is read from a stored project as a plain https address, and dropped when it is anything else", () => {
    expect(
      parseStoredProjectDynamicOverrides({
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
        dynamicProviderAddress: "https://api.deepseek.example/v1",
      }),
    ).toEqual({
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
      dynamicProviderAddress: "https://api.deepseek.example/v1",
    });
    for (const dynamicProviderAddress of [
      "http://api.deepseek.example",
      "api.deepseek.example",
      42,
      null,
      `https://${"a".repeat(2100)}.example`,
    ])
      expect(
        parseStoredProjectDynamicOverrides({
          dynamicProvider: "deepseek",
          dynamicProviderAddress,
        }),
      ).toEqual({ dynamicProvider: "deepseek" });
  });
});
