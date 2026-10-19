// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readBillingSettings } from "./settings.ts";

describe("the stored billing settings", () => {
  // #491-T06
  it("reads a value of the old shape with the extra fields ignored", () => {
    expect(
      readBillingSettings({
        environment: "live",
        clientToken: "live_0123456789abcdef0123456789a",
        graceDays: 7,
        enabled: true,
      }),
    ).toEqual({ enabled: true });
  });

  // #491-T06
  it.each([
    ["true", "a string"],
    [1, "a number"],
    [null, "null"],
    [undefined, "nothing"],
    ["yes", "other text"],
    [false, "false"],
  ] as Array<[unknown, string]>)("reads enabled %j (%s) as off", (enabled) => {
    expect(
      readBillingSettings({ environment: "sandbox", enabled }).enabled,
    ).toBe(false);
  });

  // #491-T06
  it.each([null, undefined, "on", 3, [], [true]])(
    "reads %j, which is no object, as off",
    (stored) => {
      expect(readBillingSettings(stored)).toEqual({ enabled: false });
    },
  );
});
