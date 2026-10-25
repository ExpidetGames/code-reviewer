// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { netShareMicroUsd } from "./net-share.ts";

const USD = 1_000_000;

describe("the net share of a refund or dispute", () => {
  // #497-T07
  it("is exactly the credit when the whole payment is taken, tax or not", () => {
    expect(
      netShareMicroUsd({
        credited: 25 * USD,
        amount: 29_750_000,
        paymentAmount: 29_750_000,
      }),
    ).toBe(25 * USD);
    expect(
      netShareMicroUsd({ credited: 25 * USD, amount: 7, paymentAmount: 7 }),
    ).toBe(25 * USD);
  });

  // #497-T07
  it("is the same share in any unit and any currency, because only the ratio counts", () => {
    const inMicro = netShareMicroUsd({
      credited: 25 * USD,
      amount: 14_875_000,
      paymentAmount: 29_750_000,
    });
    const inCents = netShareMicroUsd({
      credited: 25 * USD,
      amount: 1_487.5 * 2,
      paymentAmount: 5_950,
    });
    expect(inMicro).toBe(12_500_000);
    expect(inCents).toBe(12_500_000);
  });

  // #497-T07
  it("rounds down, so the shares of a payment never add up to more than its credit", () => {
    const third = netShareMicroUsd({
      credited: 25 * USD,
      amount: 1,
      paymentAmount: 3,
    });
    expect(third).toBe(8_333_333);
    expect(3 * (third ?? 0)).toBeLessThanOrEqual(25 * USD);
  });

  // #497-T07
  it("has no share for an amount above the payment, a share that rounds to nothing, or a bad number", () => {
    const base = { credited: 25 * USD, amount: 10, paymentAmount: 10 };
    expect(netShareMicroUsd({ ...base, amount: 11 })).toBeUndefined();
    expect(
      netShareMicroUsd({ credited: 1, amount: 1, paymentAmount: 3 }),
    ).toBeUndefined();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(netShareMicroUsd({ ...base, amount: bad })).toBeUndefined();
      expect(netShareMicroUsd({ ...base, paymentAmount: bad })).toBeUndefined();
      expect(netShareMicroUsd({ ...base, credited: bad })).toBeUndefined();
    }
  });

  // #497-T07
  it("computes with whole numbers: no precision is lost where a float product would be", () => {
    const credited = 499_999_999;
    const paymentAmount = Number.MAX_SAFE_INTEGER;
    const amount = Number.MAX_SAFE_INTEGER - 1;
    const expected = Number(
      (BigInt(credited) * BigInt(amount)) / BigInt(paymentAmount),
    );
    expect(netShareMicroUsd({ credited, amount, paymentAmount })).toBe(
      expected,
    );
    expect(expected).toBe(499_999_998);
  });
});
