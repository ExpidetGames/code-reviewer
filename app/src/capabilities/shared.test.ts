// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  CapabilityConfigError,
  getCapabilities,
  getDeploymentCapabilities,
} from "./shared.ts";

describe("the capability set of the running server", () => {
  it("is read from the environment it is given, and again when that changes", () => {
    expect(getCapabilities({}).list()).toEqual([
      "billing",
      "dynamic-review",
      "review",
    ]);
    expect(getCapabilities({ PRODUCT_CAPABILITIES: "review" }).list()).toEqual([
      "review",
    ]);
    expect(getDeploymentCapabilities({ PRODUCT_ID: "factory" })).toMatchObject({
      product: "factory",
    });
  });

  it("throws, with a stable code and the variable, for a setting it cannot use", () => {
    expect(() => getCapabilities({ PRODUCT_CAPABILITIES: "nonsense" })).toThrow(
      CapabilityConfigError,
    );
    expect(() => getCapabilities({ PRODUCT_CAPABILITIES: "nonsense" })).toThrow(
      /CAPABILITIES_INVALID: PRODUCT_CAPABILITIES/,
    );
  });
});
