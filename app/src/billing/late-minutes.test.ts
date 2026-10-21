// SPDX-License-Identifier: Apache-2.0

// The minutes a late end of a VM may settle at (#498, #493): a stop answer that arrives late is our error, so it never adds
// charge beyond the backstop the settlement already used, while a real end that is earlier credits the customer.
import { describe, expect, it } from "vitest";
import { lateMinutesTarget } from "./late-minutes.ts";

describe("the minutes a late end settles at", () => {
  // #498-T24
  it("never goes above the backstop, however late the end arrives", () => {
    expect(lateMinutesTarget({ settled: 2, measured: 11, backstop: 2 })).toBe(
      2,
    );
    expect(lateMinutesTarget({ settled: 2, measured: 11, backstop: 5 })).toBe(
      5,
    );
  });

  // #498-T24
  it("keeps what was settled when it is already above the backstop", () => {
    expect(lateMinutesTarget({ settled: 6, measured: 11, backstop: 5 })).toBe(
      6,
    );
  });

  // #498-T24
  it("takes a measure below the settlement as it is, so a credit is allowed", () => {
    expect(lateMinutesTarget({ settled: 6, measured: 3, backstop: 6 })).toBe(3);
  });

  // #498-T24
  it("allows no increase when the backstop is not known", () => {
    expect(
      lateMinutesTarget({ settled: 2, measured: 11, backstop: null }),
    ).toBe(2);
    expect(lateMinutesTarget({ settled: 6, measured: 3, backstop: null })).toBe(
      3,
    );
  });
});
