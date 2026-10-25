// SPDX-License-Identifier: LicenseRef-Proprietary

// The decimals of the billing page and the whole numbers behind them: dollars to micro-USD and back, the factor A to parts per
// 10,000 and back. No floating point touches an amount: the text is split at the decimal point and read as digits.
import { describe, expect, it } from "vitest";
import {
  formatFactor,
  formatUsd,
  formatUsdFixed,
  parseFactor,
  parseUsd,
  parseWhole,
} from "./billing-money.ts";

describe("dollars to micro-USD", () => {
  // #504-T09
  it.each([
    ["0.013", 13_000],
    ["0.016", 16_000],
    ["2", 2_000_000],
    ["2.5", 2_500_000],
    ["0.15", 150_000],
    ["0.000001", 1],
    ["10000", 10_000_000_000],
    ["0", 0],
    ["  7.25  ", 7_250_000],
    [".5", 500_000],
    ["1.", 1_000_000],
    ["007", 7_000_000],
  ])("reads %j as %i", (text, micro) => {
    expect(parseUsd(text)).toBe(micro);
  });

  // #504-T09
  it.each([
    "",
    " ",
    "abc",
    "1,5",
    "1.2.3",
    "0.0000001",
    "-1",
    "+1",
    "1e3",
    "$2",
    "2 USD",
    "0x10",
    "Infinity",
    "NaN",
    "９",
    "99999999999999999999",
  ])("refuses %j", (text) => {
    expect(parseUsd(text)).toBeNull();
  });

  // #504-T10
  it("reads a signed amount only when asked to, for a correction", () => {
    expect(parseUsd("-2", { signed: true })).toBe(-2_000_000);
    expect(parseUsd("+2.5", { signed: true })).toBe(2_500_000);
    expect(parseUsd("-0.000001", { signed: true })).toBe(-1);
    expect(parseUsd("--2", { signed: true })).toBeNull();
  });

  // #504-T09
  it("writes micro-USD as the shortest decimal and with at least two decimals", () => {
    expect(formatUsd(13_000)).toBe("0.013");
    expect(formatUsd(2_000_000)).toBe("2");
    expect(formatUsd(150_000)).toBe("0.15");
    expect(formatUsd(0)).toBe("0");
    expect(formatUsd(-2_000_000)).toBe("-2");
    expect(formatUsdFixed(8_000_000)).toBe("8.00");
    expect(formatUsdFixed(13_000)).toBe("0.013");
    expect(formatUsdFixed(150_000)).toBe("0.15");
    expect(formatUsdFixed(-2_500_000)).toBe("-2.50");
  });

  // #504-T09
  it("round trips every amount without a rounding error", () => {
    for (const micro of [0, 1, 13_000, 999_999, 1_000_001, 123_456_789])
      expect(parseUsd(formatUsd(micro))).toBe(micro);
  });
});

describe("the factor A", () => {
  // #504-T09
  it.each([
    ["5", 50_000],
    ["5.0", 50_000],
    ["1.2", 12_000],
    ["1.2345", 12_345],
    ["1", 10_000],
    ["100", 1_000_000],
  ])("reads %j as %i parts per 10,000", (text, parts) => {
    expect(parseFactor(text)).toBe(parts);
  });

  // #504-T09
  it.each(["", "abc", "1.23456", "-1", "1,2", "5x", "1e1"])(
    "refuses %j",
    (text) => {
      expect(parseFactor(text)).toBeNull();
    },
  );

  // #504-T09
  it("writes parts per 10,000 as the shortest decimal", () => {
    expect(formatFactor(50_000)).toBe("5");
    expect(formatFactor(12_000)).toBe("1.2");
    expect(formatFactor(12_345)).toBe("1.2345");
    expect(formatFactor(10_000)).toBe("1");
  });
});

describe("a whole number", () => {
  // #504-T09
  it.each([
    ["60", 60],
    [" 7 ", 7],
    ["0", 0],
  ])("reads %j as %i", (text, value) => {
    expect(parseWhole(text)).toBe(value);
  });

  // #504-T09
  it.each(["", "1.5", "-1", "six", "1e3", "99999999999999999999"])(
    "refuses %j",
    (text) => {
      expect(parseWhole(text)).toBeNull();
    },
  );
});
