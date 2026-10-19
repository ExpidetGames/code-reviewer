// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BILLING_RATE_ERROR_CODES,
  DEFAULT_DIFF_AI_RESERVE_MICRO_USD,
  DIFF_AI_RESERVE_MAX_MICRO_USD,
  FACTOR_A_MAX,
  FACTOR_A_MIN,
  MINUTE_RATE_MAX_MICRO_USD,
  billingRatesOf,
  canSwitchBillingOn,
  validateRatesPatch,
} from "./rates.ts";

describe("the factor A", () => {
  // #494-T10
  it.each([FACTOR_A_MIN, 12_000, 50_000, FACTOR_A_MAX])(
    "accepts %i parts per 10,000",
    (factorA) => {
      expect(validateRatesPatch({ factorA })).toStrictEqual({
        ok: true,
        value: { factorA },
      });
    },
  );

  // #494-T10
  it.each([
    ["below 1", FACTOR_A_MIN - 1],
    ["zero", 0],
    ["negative", -12_000],
    ["above the bound", FACTOR_A_MAX + 1],
    ["a float", 12_000.5],
    ["a decimal factor instead of parts", 1.2],
    ["a string", "12000"],
    ["a numeric string", "12_000"],
    ["null", null],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["above the safe integers", 2 ** 53],
    ["a boolean", true],
    ["an object", {}],
  ])("refuses a factor that is %s", (_name, factorA) => {
    expect(validateRatesPatch({ factorA })).toStrictEqual({
      ok: false,
      code: "factor_invalid",
      field: "factorA",
    });
  });
});

describe("the rate per started minute", () => {
  // #494-T10
  it.each([0, 1, 13_000, MINUTE_RATE_MAX_MICRO_USD])(
    "accepts %i micro-USD, for each kind",
    (rate) => {
      expect(
        validateRatesPatch({
          minuteRateMicroUsd: { diff: rate, dynamic: rate },
        }),
      ).toStrictEqual({
        ok: true,
        value: { minuteRateMicroUsd: { diff: rate, dynamic: rate } },
      });
    },
  );

  // #494-T10
  it.each([
    ["negative", -1],
    ["above the bound", MINUTE_RATE_MAX_MICRO_USD + 1],
    ["a float", 0.5],
    ["a string", "10000"],
    ["null", null],
    ["not a number", Number.NaN],
  ])("refuses a rate that is %s, and names the kind", (_name, rate) => {
    expect(
      validateRatesPatch({ minuteRateMicroUsd: { diff: 100, dynamic: rate } }),
    ).toStrictEqual({
      ok: false,
      code: "rate_invalid",
      field: "minuteRateMicroUsd.dynamic",
    });
    expect(
      validateRatesPatch({ minuteRateMicroUsd: { diff: rate } }),
    ).toStrictEqual({
      ok: false,
      code: "rate_invalid",
      field: "minuteRateMicroUsd.diff",
    });
  });

  // #494-T10
  it("refuses a rate group that is no object", () => {
    expect(validateRatesPatch({ minuteRateMicroUsd: 5 })).toMatchObject({
      ok: false,
      code: "rate_invalid",
    });
    expect(validateRatesPatch({ minuteRateMicroUsd: [1, 2] })).toMatchObject({
      ok: false,
      code: "rate_invalid",
    });
  });
});

describe("the AI reserve of a Diff review", () => {
  // #494-T10
  it.each([0, 1, 400_000, DIFF_AI_RESERVE_MAX_MICRO_USD])(
    "accepts %i",
    (value) => {
      expect(
        validateRatesPatch({ diffAiReserveMicroUsd: value }),
      ).toStrictEqual({
        ok: true,
        value: { diffAiReserveMicroUsd: value },
      });
    },
  );

  // #494-T10
  it.each([
    -1,
    DIFF_AI_RESERVE_MAX_MICRO_USD + 1,
    0.5,
    "400000",
    null,
    Number.NaN,
  ])("refuses %j", (value) => {
    expect(validateRatesPatch({ diffAiReserveMicroUsd: value })).toStrictEqual({
      ok: false,
      code: "reserve_invalid",
      field: "diffAiReserveMicroUsd",
    });
  });
});

describe("a patch of the rates", () => {
  // #494-T10
  it("carries only what it states, and ignores a field it does not know", () => {
    expect(validateRatesPatch({})).toStrictEqual({ ok: true, value: {} });
    expect(
      validateRatesPatch({ factorA: 12_000, enabled: true, whatever: 1 }),
    ).toStrictEqual({ ok: true, value: { factorA: 12_000 } });
  });

  // #494-T10
  it.each([null, undefined, "x", 3, [], [{ factorA: 12_000 }]])(
    "refuses %j, which is no object",
    (input) => {
      expect(validateRatesPatch(input)).toMatchObject({ ok: false });
    },
  );

  // #494-T10
  it("refuses the whole patch when one field is wrong", () => {
    expect(
      validateRatesPatch({ factorA: 12_000, diffAiReserveMicroUsd: -1 }),
    ).toMatchObject({ ok: false, code: "reserve_invalid" });
  });

  // #494-T10
  it("has a stable code for each refusal", () => {
    expect([...BILLING_RATE_ERROR_CODES]).toStrictEqual([
      "factor_invalid",
      "rate_invalid",
      "reserve_invalid",
    ]);
  });
});

describe("whether the rates are complete", () => {
  const complete = {
    factorA: 12_000,
    minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
    diffAiReserveMicroUsd: 300_000,
  };

  // #494-T11
  it("is complete with A and both rates, and takes the reserve as stored", () => {
    expect(billingRatesOf(complete)).toStrictEqual(complete);
    expect(canSwitchBillingOn(complete)).toStrictEqual({ ok: true });
  });

  // #494-T11
  it("takes the default reserve when none is stored, and never a default for A or B", () => {
    const withoutReserve = {
      factorA: complete.factorA,
      minuteRateMicroUsd: complete.minuteRateMicroUsd,
    };
    expect(billingRatesOf(withoutReserve)).toStrictEqual({
      ...complete,
      diffAiReserveMicroUsd: DEFAULT_DIFF_AI_RESERVE_MICRO_USD,
    });
    expect(billingRatesOf({})).toBeNull();
  });

  // #494-T11
  it.each([
    ["no A", { ...complete, factorA: undefined }],
    [
      "no rate for Diff",
      { ...complete, minuteRateMicroUsd: { dynamic: 25_000 } },
    ],
    [
      "no rate for Dynamic",
      { ...complete, minuteRateMicroUsd: { diff: 10_000 } },
    ],
    ["no rates", { factorA: 12_000 }],
    ["nothing", {}],
  ])(
    "is incomplete with %s: billing cannot be switched on",
    (_name, stored) => {
      expect(billingRatesOf(stored)).toBeNull();
      expect(canSwitchBillingOn(stored)).toStrictEqual({
        ok: false,
        code: "billing_rates_incomplete",
      });
    },
  );

  // #494-T11
  it("accepts a rate of 0 as set: an operator who does not charge for a kind", () => {
    expect(
      canSwitchBillingOn({
        ...complete,
        minuteRateMicroUsd: { diff: 0, dynamic: 0 },
      }),
    ).toStrictEqual({ ok: true });
  });
});
