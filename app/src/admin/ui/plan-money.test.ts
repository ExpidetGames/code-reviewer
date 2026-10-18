// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  PRICE_MAX_MINOR,
  formatMicroAsUsd,
  formatMinorAsUsd,
  parseUsdToMicro,
  parseUsdToMinor,
} from "./plan-money.ts";

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

  // #438-N5
  it("reads a price up to 1,000,000 USD and refuses one above it, so the text never becomes a number the column cannot hold", () => {
    expect(parseUsdToMinor("1000000")).toEqual({
      ok: true,
      minor: PRICE_MAX_MINOR,
    });
    expect(parseUsdToMinor("1000000.00")).toEqual({
      ok: true,
      minor: PRICE_MAX_MINOR,
    });
    expect(parseUsdToMinor("999999.99")).toEqual({
      ok: true,
      minor: PRICE_MAX_MINOR - 1,
    });
    for (const text of ["1000000.01", "1000001", "21474836.48", "999999999"])
      expect(parseUsdToMinor(text), text).toEqual({ ok: false });
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

describe("the cost limit input", () => {
  // #438-T15
  it.each([
    ["3", 3_000_000],
    ["2.5", 2_500_000],
    ["0.000001", 1],
    ["1.234567", 1_234_567],
    ["", null],
  ])("reads %j as %s micro-USD", (text, micro) => {
    expect(parseUsdToMicro(text)).toEqual({ ok: true, micro });
  });

  // #438-T15
  it.each(["1.2345678", "-1", "abc", "1,5", "$3"])("refuses %j", (text) => {
    expect(parseUsdToMicro(text)).toEqual({ ok: false });
  });

  // #438-T15
  it("writes micro-USD back without losing a digit", () => {
    expect(formatMicroAsUsd(2_500_000)).toBe("2.50");
    expect(formatMicroAsUsd(3_000_000)).toBe("3.00");
    expect(formatMicroAsUsd(1_234_567)).toBe("1.234567");
    expect(formatMicroAsUsd(1)).toBe("0.000001");
    expect(parseUsdToMicro(formatMicroAsUsd(1_234_560))).toEqual({
      ok: true,
      micro: 1_234_560,
    });
  });
});
