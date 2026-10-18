// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatMinorAsUsd, parseUsdToMinor } from "./plan-money.ts";

describe("the price input", () => {
  // #438-T25
  it.each([
    ["9.99", 999],
    ["10", 1000],
    ["10.5", 1050],
    ["0.99", 99],
    ["  12.30 ", 1230],
  ])("reads %j as %i minor units", (text, minor) => {
    expect(parseUsdToMinor(text)).toEqual({ ok: true, minor });
  });

  // #438-T25
  it("reads an empty field as no price", () => {
    expect(parseUsdToMinor("")).toEqual({ ok: true, minor: null });
    expect(parseUsdToMinor("   ")).toEqual({ ok: true, minor: null });
  });

  // #438-T24
  it.each([
    "9.999",
    "-5",
    "abc",
    "1,000",
    "$10",
    "1e3",
    "10.",
    ".5",
    "NaN",
    "9007199254740993",
  ])("refuses %j", (text) => {
    expect(parseUsdToMinor(text)).toEqual({ ok: false });
  });

  // #438-T25
  it("keeps zero as a number, for the validation of the version to refuse", () => {
    expect(parseUsdToMinor("0")).toEqual({ ok: true, minor: 0 });
    expect(parseUsdToMinor("0.00")).toEqual({ ok: true, minor: 0 });
  });

  // #438-T25
  it("writes minor units back as the text of the input", () => {
    expect(formatMinorAsUsd(999)).toBe("9.99");
    expect(formatMinorAsUsd(1000)).toBe("10.00");
    expect(formatMinorAsUsd(5)).toBe("0.05");
    expect(parseUsdToMinor(formatMinorAsUsd(1234))).toEqual({
      ok: true,
      minor: 1234,
    });
  });
});
