// SPDX-License-Identifier: Apache-2.0

// The pure rules that decide whether a Paddle price is the price of a plan version (#439, ADR 0005, 2.11): the amount the
// operator entered, the interval of the slot, USD, tax inclusive, active, without overrides, of the plan's product. No
// database, no Paddle: the facts of a price are made up here.
import { describe, expect, it } from "vitest";
import {
  PRICE_RULE_ERROR_CODES,
  amountEquals,
  checkPrice,
  trialDaysOf,
  type PriceFacts,
} from "./price-rules.ts";

function facts(overrides: Partial<PriceFacts> = {}): PriceFacts {
  return {
    status: "active",
    recurring: true,
    interval: "month",
    frequency: 1,
    currency: "USD",
    taxMode: "internal",
    amount: "1234",
    hasOverrides: false,
    productId: "pro_01fake00000000000000000001",
    ...overrides,
  };
}

const MONTHLY = {
  interval: "month",
  amountMinor: 1234,
  productId: "pro_01fake00000000000000000001",
} as const;

describe("checking a Paddle price against a version's slot", () => {
  it("accepts a price that is exactly what was entered", () => {
    expect(checkPrice(facts(), MONTHLY)).toBeUndefined();
  });

  it("accepts any product when the plan has none yet", () => {
    expect(
      checkPrice(facts({ productId: "pro_other" }), {
        ...MONTHLY,
        productId: null,
      }),
    ).toBeUndefined();
  });

  it("refuses an archived price before anything else", () => {
    expect(
      checkPrice(facts({ status: "archived", currency: "EUR" }), MONTHLY),
    ).toEqual({ code: "price_not_active" });
  });

  it("refuses a one-time price", () => {
    expect(checkPrice(facts({ recurring: false }), MONTHLY)).toEqual({
      code: "price_not_recurring",
    });
  });

  // #439-T12
  it("refuses another interval, or a frequency other than one, with the two values", () => {
    expect(checkPrice(facts({ interval: "year" }), MONTHLY)).toEqual({
      code: "price_interval_mismatch",
      entered: "month",
      paddle: "year",
    });
    expect(checkPrice(facts({ frequency: 3 }), MONTHLY)).toEqual({
      code: "price_interval_mismatch",
      entered: "month",
      paddle: "3 months",
    });
  });

  // #439-T13
  it("refuses any currency but USD with the two values", () => {
    expect(checkPrice(facts({ currency: "EUR" }), MONTHLY)).toEqual({
      code: "price_currency_mismatch",
      entered: "USD",
      paddle: "EUR",
    });
  });

  // #439-T14
  it("refuses a tax mode that is not explicitly internal", () => {
    for (const taxMode of ["external", "account_setting", "location"]) {
      expect(checkPrice(facts({ taxMode }), MONTHLY)).toEqual({
        code: "price_tax_mode_mismatch",
        entered: "internal",
        paddle: taxMode,
      });
    }
  });

  // #439-T11
  it("refuses another amount and reports both in minor units", () => {
    expect(checkPrice(facts({ amount: "1235" }), MONTHLY)).toEqual({
      code: "price_amount_mismatch",
      entered: "1234",
      paddle: "1235",
    });
  });

  it("refuses overrides and another product", () => {
    expect(checkPrice(facts({ hasOverrides: true }), MONTHLY)).toEqual({
      code: "price_has_overrides",
    });
    expect(checkPrice(facts({ productId: "pro_other" }), MONTHLY)).toEqual({
      code: "price_product_mismatch",
    });
  });

  // #439-T15
  it("reports one code in the fixed order: interval, currency, tax mode, amount", () => {
    const everythingWrong = facts({
      interval: "year",
      currency: "EUR",
      taxMode: "external",
      amount: "1",
    });

    expect(checkPrice(everythingWrong, MONTHLY)?.code).toBe(
      "price_interval_mismatch",
    );
    expect(
      checkPrice({ ...everythingWrong, interval: "month" }, MONTHLY)?.code,
    ).toBe("price_currency_mismatch");
    expect(
      checkPrice(
        { ...everythingWrong, interval: "month", currency: "USD" },
        MONTHLY,
      )?.code,
    ).toBe("price_tax_mode_mismatch");
    expect(
      checkPrice(
        {
          ...everythingWrong,
          interval: "month",
          currency: "USD",
          taxMode: "internal",
        },
        MONTHLY,
      )?.code,
    ).toBe("price_amount_mismatch");
  });

  it("has a code for every refusal it can give", () => {
    expect([...PRICE_RULE_ERROR_CODES].sort()).toEqual(
      [
        "price_amount_mismatch",
        "price_currency_mismatch",
        "price_environment_mismatch",
        "price_has_overrides",
        "price_interval_mismatch",
        "price_not_active",
        "price_not_found",
        "price_not_recurring",
        "price_product_mismatch",
        "price_tax_mode_mismatch",
        "price_yearly_not_entered",
      ].sort(),
    );
  });
});

describe("comparing the entered amount with the one Paddle sends", () => {
  // #439-T17
  it("compares integers: the string of minor units equals the entered number", () => {
    expect(amountEquals(1000, "1000")).toBe(true);
    expect(amountEquals(1, "1")).toBe(true);
    expect(amountEquals(1000, "01000")).toBe(true);
  });

  // #439-T17
  it("never rounds, never reads a decimal or an exponent, and never lets a large number lose digits", () => {
    expect(amountEquals(1000, "1000.0")).toBe(false);
    expect(amountEquals(1000, "10.00")).toBe(false);
    expect(amountEquals(1000, "1e3")).toBe(false);
    expect(amountEquals(1000, "1000.4")).toBe(false);
    expect(amountEquals(1000, " 1000")).toBe(false);
    expect(amountEquals(1000, "")).toBe(false);
    expect(amountEquals(1000, "-1000")).toBe(false);
    expect(amountEquals(1000, "0x3e8")).toBe(false);
    // A float would call these equal; integers do not.
    expect(amountEquals(9_007_199_254_740_991, "9007199254740992")).toBe(false);
    expect(amountEquals(1000, "1000000000000000000001")).toBe(false);
  });
});

describe("the trial of a price", () => {
  it("is read from the price in days and is none when the price has no trial", () => {
    expect(trialDaysOf(null)).toBeNull();
    expect(trialDaysOf(undefined)).toBeNull();
    expect(trialDaysOf({ interval: "day", frequency: 14 })).toBe(14);
    expect(trialDaysOf({ interval: "week", frequency: 2 })).toBe(14);
  });
});
