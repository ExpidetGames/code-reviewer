// SPDX-License-Identifier: Apache-2.0

// The pure rules for creating the Paddle price of a plan version (#440, ADR 0005, 2.11): which amount is sent, what the
// request looks like, how an attempt is named, and which price Paddle holds for an attempt. No database, no Paddle: all
// numbers are made up.
import { describe, expect, it } from "vitest";
import type { PaddlePrice } from "./paddle-schemas.ts";
import {
  MAX_TRIAL_DAYS,
  amountToCreate,
  intentIdOf,
  matchesIntent,
  priceRequestOf,
  trialDaysToCreate,
} from "./price-create-rules.ts";

const PRODUCT = "pro_01fake00000000000000000001";

function paddlePrice(overrides: Partial<PaddlePrice> = {}): PaddlePrice {
  return {
    id: "pri_01fake00000000000000000001",
    product_id: PRODUCT,
    description: "Monthly",
    type: "standard",
    status: "active",
    tax_mode: "internal",
    billing_cycle: { interval: "month", frequency: 1 },
    unit_price: { amount: "1234", currency_code: "USD" },
    quantity: { minimum: 1, maximum: 1 },
    custom_data: { cr_plan_key: "team", cr_intent: "cri_v1_month_0" },
    created_at: "2026-10-18T10:00:00.000000Z",
    updated_at: "2026-10-18T10:00:00.000000Z",
    ...overrides,
  };
}

describe("the amount that is sent", () => {
  // #440-T05
  it.each([1, 1234, 100_000_000, Number.MAX_SAFE_INTEGER])(
    "is the stored whole number of minor units as a string: %d",
    (stored) => {
      expect(amountToCreate(stored)).toEqual({
        ok: true,
        amount: String(stored),
      });
    },
  );

  // #440-T05
  it.each([
    0,
    -5,
    12.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    null,
    undefined,
    "1234",
  ])(
    "refuses a stored value that is not a positive whole number: %s",
    (stored) => {
      expect(amountToCreate(stored)).toEqual({ ok: false });
    },
  );
});

describe("the trial of a created price", () => {
  // #440-T06
  it("is off unless days are given", () => {
    expect(trialDaysToCreate(undefined)).toEqual({ ok: true, days: null });
    expect(trialDaysToCreate(null)).toEqual({ ok: true, days: null });
  });

  // #440-T06
  it.each([1, 7, 30, MAX_TRIAL_DAYS])("takes whole days: %d", (days) => {
    expect(trialDaysToCreate(days)).toEqual({ ok: true, days });
  });

  // #440-T06
  it.each([0, -1, 1.5, MAX_TRIAL_DAYS + 1, "7", Number.NaN, true, {}])(
    "refuses anything else: %s",
    (days) => {
      expect(trialDaysToCreate(days)).toEqual({ ok: false });
    },
  );
});

describe("the request that creates a price", () => {
  // #440-T12
  it("carries the entered amount, USD, tax inclusive, one month, a quantity of one and the intent, and nothing else", () => {
    expect(
      priceRequestOf({
        planKey: "team",
        intentId: "cri_v1_month_0",
        productId: PRODUCT,
        interval: "month",
        amount: "1234",
        trialDays: null,
      }),
    ).toEqual({
      product_id: PRODUCT,
      type: "standard",
      description: "Monthly price of the plan team",
      unit_price: { amount: "1234", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      tax_mode: "internal",
      quantity: { minimum: 1, maximum: 1 },
      custom_data: { cr_plan_key: "team", cr_intent: "cri_v1_month_0" },
    });
  });

  // #440-T12
  it("is one year for the yearly slot", () => {
    const request = priceRequestOf({
      planKey: "team",
      intentId: "cri_v1_year_0",
      productId: PRODUCT,
      interval: "year",
      amount: "12340",
      trialDays: null,
    });
    expect(request.billing_cycle).toEqual({ interval: "year", frequency: 1 });
    expect(request.unit_price.amount).toBe("12340");
    expect(request.description).toBe("Yearly price of the plan team");
  });

  // #440-T06
  it("carries the trial in days when there is one, and no trial field when there is none", () => {
    const base = {
      planKey: "team",
      intentId: "cri_v1_month_14",
      productId: PRODUCT,
      interval: "month",
      amount: "1234",
    } as const;
    expect(priceRequestOf({ ...base, trialDays: 14 }).trial_period).toEqual({
      interval: "day",
      frequency: 14,
    });
    expect("trial_period" in priceRequestOf({ ...base, trialDays: null })).toBe(
      false,
    );
  });

  // #440-T13
  it("has no override and no field a caller could add: the keys are fixed", () => {
    const request = priceRequestOf({
      planKey: "team",
      intentId: "cri_v1_month_0",
      productId: PRODUCT,
      interval: "month",
      amount: "1234",
      trialDays: null,
    });
    expect(Object.keys(request).sort()).toEqual([
      "billing_cycle",
      "custom_data",
      "description",
      "product_id",
      "quantity",
      "tax_mode",
      "type",
      "unit_price",
    ]);
  });
});

describe("the name of an attempt", () => {
  // #440-T09
  it("is the same for the same version, slot and trial, and different for any other", () => {
    const base = { versionId: "bpv_1", interval: "month", trialDays: null };
    expect(intentIdOf(base)).toBe(intentIdOf({ ...base }));
    expect(intentIdOf(base)).not.toBe(
      intentIdOf({ ...base, interval: "year" }),
    );
    expect(intentIdOf(base)).not.toBe(
      intentIdOf({ ...base, versionId: "bpv_2" }),
    );
    expect(intentIdOf(base)).not.toBe(intentIdOf({ ...base, trialDays: 7 }));
    expect(intentIdOf({ ...base, trialDays: 7 })).not.toBe(
      intentIdOf({ ...base, trialDays: 70 }),
    );
  });

  // #440-T02
  it("is plain text a Paddle custom data field can hold", () => {
    expect(
      intentIdOf({ versionId: "bpv_1", interval: "year", trialDays: 14 }),
    ).toMatch(/^cri_[A-Za-z0-9_]+$/);
  });
});

describe("which Paddle price belongs to an attempt", () => {
  // #440-T02
  it("is the one that carries the intent and the plan key in its custom data", () => {
    expect(matchesIntent(paddlePrice(), "cri_v1_month_0", "team")).toBe(true);
  });

  // #440-T02
  it.each([
    ["another intent", { cr_plan_key: "team", cr_intent: "cri_v2_month_0" }],
    ["another plan", { cr_plan_key: "pro", cr_intent: "cri_v1_month_0" }],
    ["no intent", { cr_plan_key: "team" }],
    ["an intent that is not text", { cr_plan_key: "team", cr_intent: 5 }],
    ["no custom data", null],
  ])("is not a price with %s", (_name, customData) => {
    expect(
      matchesIntent(
        paddlePrice({ custom_data: customData }),
        "cri_v1_month_0",
        "team",
      ),
    ).toBe(false);
  });

  // #440-T02
  it("is not a price that is archived", () => {
    expect(
      matchesIntent(
        paddlePrice({ status: "archived" }),
        "cri_v1_month_0",
        "team",
      ),
    ).toBe(false);
  });
});
