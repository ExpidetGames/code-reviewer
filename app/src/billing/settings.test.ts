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

  // #494-T11
  it("reads the rates it finds and the switch next to them", () => {
    expect(
      readBillingSettings({
        enabled: true,
        factorA: 12_000,
        minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
        diffAiReserveMicroUsd: 300_000,
      }),
    ).toStrictEqual({
      enabled: true,
      factorA: 12_000,
      minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
      diffAiReserveMicroUsd: 300_000,
    });
  });

  // #494-T11
  it.each([
    ["a string", { factorA: "12000" }],
    ["a float", { factorA: 12_000.5 }],
    ["below 1", { factorA: 100 }],
    ["negative", { factorA: -1 }],
    ["null", { factorA: null }],
    ["a boolean", { factorA: true }],
  ])("reads a damaged factor (%s) as not set", (_name, stored) => {
    expect(readBillingSettings({ enabled: true, ...stored })).toStrictEqual({
      enabled: true,
    });
  });

  // #494-T11
  it("reads a damaged rate, group or reserve as not set, field by field", () => {
    expect(
      readBillingSettings({
        enabled: false,
        factorA: 12_000,
        minuteRateMicroUsd: { diff: -5, dynamic: 25_000 },
        diffAiReserveMicroUsd: "lots",
      }),
    ).toStrictEqual({
      enabled: false,
      factorA: 12_000,
      minuteRateMicroUsd: { dynamic: 25_000 },
    });
    expect(
      readBillingSettings({ enabled: true, minuteRateMicroUsd: "free" }),
    ).toStrictEqual({ enabled: true });
    expect(
      readBillingSettings({ enabled: true, minuteRateMicroUsd: [1, 2] }),
    ).toStrictEqual({ enabled: true });
  });
});
