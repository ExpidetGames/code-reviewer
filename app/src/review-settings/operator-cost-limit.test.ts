// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  checkOperatorCostLimit,
  DEFAULT_OPERATOR_COST_LIMIT_CENTS,
  operatorCostLimitCentsOf,
  OPERATOR_COST_LIMIT_BOUNDS,
} from "./operator-cost-limit.ts";
import { REVIEW_SETTING_LIMITS } from "./settings.ts";

describe("the operator's maximum cost per review", () => {
  // #689-T10
  it("is 1.00 US dollar until the admin sets it, which is what Dynamic Review was held to before", () => {
    expect(DEFAULT_OPERATOR_COST_LIMIT_CENTS).toBe(100);
    expect(operatorCostLimitCentsOf(undefined)).toBe(100);
  });

  // #689-T10
  it("has the bounds of a customer's own limit, so any limit a customer can set can also be the maximum", () => {
    expect(OPERATOR_COST_LIMIT_BOUNDS).toEqual(
      REVIEW_SETTING_LIMITS.maxCostCents,
    );
  });

  // #689-T10
  it.each([1, 100, 250, 10_000])("takes %d cents", (cents) => {
    expect(checkOperatorCostLimit(cents)).toEqual({ ok: true, value: cents });
    expect(operatorCostLimitCentsOf(cents)).toBe(cents);
  });

  // #689-T10
  it.each([0, -5, 10_001, 1.5, Number.NaN, "100", null, undefined, {}])(
    "refuses %j",
    (value) => {
      expect(checkOperatorCostLimit(value)).toEqual({
        ok: false,
        code: "number_out_of_range",
      });
    },
  );

  // #689-T10
  it("reads a stored value that is not valid as the default, never as no limit", () => {
    for (const stored of [0, -1, 10_001, 2.5, "100", null, {}])
      expect(operatorCostLimitCentsOf(stored)).toBe(
        DEFAULT_OPERATOR_COST_LIMIT_CENTS,
      );
  });
});
