// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  PERIOD_START_FUTURE_TOLERANCE_MS,
  checkPeriodStartNotBackwards,
  validateEntitlements,
} from "./entitlements-validation.ts";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function limits(overrides: Record<string, unknown> = {}): unknown {
  return {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}): unknown {
  return {
    planLabel: "team",
    keyMode: "own",
    limits: limits({ diffRunsPerPeriod: 10, managedCostLimitMicroUsd: 0 }),
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

describe("validating entitlements", () => {
  it("accepts a valid set and returns it in canonical form", () => {
    expect(
      validateEntitlements(input({ periodStart: "2026-10-01T02:00:00Z" }), NOW),
    ).toEqual({
      ok: true,
      value: {
        planLabel: "team",
        keyMode: "own",
        limits: {
          diffRunsPerPeriod: 10,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 0,
        },
        periodStart: "2026-10-01T02:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      },
    });
  });

  it("accepts the largest safe integer as a limit", () => {
    const result = validateEntitlements(
      input({ limits: limits({ diffRunsPerPeriod: 2 ** 53 - 1 }) }),
      NOW,
    );

    expect(result.ok).toBe(true);
  });

  // #271-T04
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "10"],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["above 2^53-1", 2 ** 53],
    ["undefined", undefined],
    ["a boolean", true],
  ])("refuses a limit that is %s", (_name, value) => {
    expect(
      validateEntitlements(
        input({ limits: limits({ dynamicRunsPerPeriod: value }) }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: "limit_invalid",
      field: "dynamicRunsPerPeriod",
    });
  });

  // #271-T04
  it("refuses limits that are not an object, miss a key or name an unknown one", () => {
    for (const bad of [
      null,
      "10",
      [],
      { diffRunsPerPeriod: 1 },
      { ...(limits() as object), extra: 1 },
    ])
      expect(validateEntitlements(input({ limits: bad }), NOW)).toMatchObject({
        ok: false,
        code: "limits_invalid",
      });
  });

  // #271-T04
  it.each(["", "OWN", "shared", null, 1, undefined])(
    "refuses the key mode %j",
    (keyMode) => {
      expect(validateEntitlements(input({ keyMode }), NOW)).toEqual({
        ok: false,
        code: "key_mode_invalid",
      });
    },
  );

  // #271-T04
  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(65)],
    ["with a line break", "team\nplus"],
    ["with a tab", "team\tplus"],
    ["with a NUL", "team\u0000"],
    ["with an escape", "team\u001b[31m"],
    ["with a bidi override", "team‮plus"],
    ["not text", 5],
  ])("refuses a plan label that is %s", (_name, planLabel) => {
    expect(validateEntitlements(input({ planLabel }), NOW)).toEqual({
      ok: false,
      code: "plan_label_invalid",
    });
  });

  it("counts the length of a label in characters, not in bytes", () => {
    expect(
      validateEntitlements(input({ planLabel: "é".repeat(64) }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ planLabel: "😀".repeat(64) }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ planLabel: "😀".repeat(65) }), NOW).ok,
    ).toBe(false);
  });

  // #271-T04
  it.each([
    ["not text", 1760000000000],
    ["not a time", "yesterday"],
    ["a date without a time", "2026-10-01"],
    ["a time with an offset", "2026-10-01T00:00:00+02:00"],
    ["a day that does not exist", "2026-02-31T00:00:00Z"],
  ])("refuses a period start that is %s", (_name, periodStart) => {
    expect(validateEntitlements(input({ periodStart }), NOW)).toEqual({
      ok: false,
      code: "period_start_invalid",
    });
  });

  it("allows a period start a few minutes in the future and refuses a later one", () => {
    const edge = new Date(NOW.getTime() + PERIOD_START_FUTURE_TOLERANCE_MS);
    const later = new Date(edge.getTime() + 1);

    expect(
      validateEntitlements(input({ periodStart: edge.toISOString() }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ periodStart: later.toISOString() }), NOW),
    ).toEqual({ ok: false, code: "period_start_in_future" });
  });

  it("refuses a suspended flag that is not a boolean", () => {
    expect(validateEntitlements(input({ suspended: 1 }), NOW)).toEqual({
      ok: false,
      code: "suspended_invalid",
    });
  });

  it.each(["", "Payment", "has space", "a".repeat(65), "1abc", 5])(
    "refuses the suspension code %j",
    (suspensionCode) => {
      expect(
        validateEntitlements(input({ suspended: true, suspensionCode }), NOW),
      ).toEqual({ ok: false, code: "suspension_code_invalid" });
    },
  );

  // #271-T09
  it("keeps a suspension code only while suspended", () => {
    expect(
      validateEntitlements(
        input({ suspended: true, suspensionCode: "payment_overdue" }),
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      value: { suspended: true, suspensionCode: "payment_overdue" },
    });
    expect(
      validateEntitlements(
        input({ suspended: false, suspensionCode: "payment_overdue" }),
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      value: { suspended: false, suspensionCode: null },
    });
  });

  it("refuses an input that is not an object", () => {
    for (const bad of [null, undefined, "x", 1, []])
      expect(validateEntitlements(bad, NOW)).toMatchObject({ ok: false });
  });
});

describe("checking that a period start does not go backwards", () => {
  // #271-T05
  it("refuses an earlier value, and accepts a later one, the same one and a first one", () => {
    const stored = "2026-10-01T00:00:00.000Z";

    expect(
      checkPeriodStartNotBackwards("2026-09-30T23:59:59.999Z", stored),
    ).toBe("period_start_backwards");
    expect(checkPeriodStartNotBackwards(stored, stored)).toBeUndefined();
    expect(
      checkPeriodStartNotBackwards("2026-10-01T00:00:00.001Z", stored),
    ).toBeUndefined();
    expect(checkPeriodStartNotBackwards(stored, undefined)).toBeUndefined();
  });
});
