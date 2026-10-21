// SPDX-License-Identifier: Apache-2.0

// #506: where a balance stands against the threshold, the one reading the mails, the banner and the claim share.
import { describe, expect, it } from "vitest";
import { balanceLevelOf, kindsInStateOf } from "./balance-state.ts";

const FIVE = 5_000_000;

describe("the level of a balance", () => {
  // #506-T01
  it.each([
    [6_000_000, "ok"],
    [FIVE, "ok"],
    [FIVE - 1, "low"],
    [10_000, "low"],
    [1, "low"],
    [0, "empty"],
    [-1, "negative"],
    [-3_000_000, "negative"],
  ] as const)("calls %i micro-USD %s against a threshold of 5 USD", (balance, level) => {
    expect(balanceLevelOf(balance, FIVE)).toBe(level);
  });

  // #506-T01
  it("has no low state when the threshold is zero, only the empty one", () => {
    expect(balanceLevelOf(1, 0)).toBe("ok");
    expect(balanceLevelOf(0, 0)).toBe("empty");
    expect(balanceLevelOf(-1, 0)).toBe("negative");
  });

  // #506-T05
  it("counts a balance below zero as empty and low for the mails", () => {
    expect(kindsInStateOf(-1, FIVE)).toEqual({ empty: true, low: true });
    expect(kindsInStateOf(0, FIVE)).toEqual({ empty: true, low: true });
    expect(kindsInStateOf(1, FIVE)).toEqual({ empty: false, low: true });
    expect(kindsInStateOf(FIVE, FIVE)).toEqual({ empty: false, low: false });
  });
});
