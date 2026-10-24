// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  NATIVE_PROVIDERS_VARIABLE,
  legacyProvidersFor,
  nativeProvidersEnabled,
} from "./switch.ts";

describe("the switch of the native providers", () => {
  // #578-T02
  it("is off when the variable is not set, empty, or says anything but yes", () => {
    for (const value of [
      undefined,
      "",
      " ",
      "0",
      "false",
      "off",
      "no",
      "2",
      "enabled",
      "1 1",
    ])
      expect(
        nativeProvidersEnabled({ [NATIVE_PROVIDERS_VARIABLE]: value }),
      ).toBe(false);
    expect(nativeProvidersEnabled({})).toBe(false);
  });

  // #578-T02
  it("is on for the documented spellings, whatever the case or the padding", () => {
    for (const value of ["1", "true", "on", "TRUE", " On ", "\t1\n"])
      expect(
        nativeProvidersEnabled({ [NATIVE_PROVIDERS_VARIABLE]: value }),
      ).toBe(true);
  });

  // #578-T01
  it("keeps the registry's providers on their wires while it is off, and releases them when it is on", () => {
    const registry = ["openrouter", "anthropic"];

    expect(legacyProvidersFor({}, registry)).toEqual(registry);
    expect(
      legacyProvidersFor({ [NATIVE_PROVIDERS_VARIABLE]: "1" }, registry),
    ).toEqual([]);
  });
});
