// SPDX-License-Identifier: Apache-2.0

// How the workspace billing page writes and reads money (#505): micro-USD integers in, text out, and a typed top-up amount back
// to whole cents. No floating point touches an amount.
import { describe, expect, it } from "vitest";
import {
  formatInvoiceAmount,
  formatMoney,
  formatPrice,
  formatSignedMoney,
  MONTHLY_LIMIT_MAX_CENTS,
  MONTHLY_LIMIT_MIN_CENTS,
  parseLimitCents,
  parseTopUpCents,
  TOP_UP_MAX_CENTS,
  TOP_UP_MIN_CENTS,
} from "./money.ts";

describe("money as text", () => {
  // #505-T01
  it.each([
    [0, "$0.00"],
    [5_000_000, "$5.00"],
    [7_981_800, "$7.9818"],
    [7_980_000, "$7.98"],
    [1_300_000, "$1.30"],
    [12_345_678, "$12.3457"],
    [-500_000, "-$0.50"],
    [-12_345_678, "-$12.3457"],
    [1_000_000_000, "$1,000.00"],
  ])("writes %i micro-USD as %s", (micro, text) => {
    expect(formatMoney(micro)).toBe(text);
  });

  // #505-T01
  it("rounds half away from zero at four decimals and never shows a non-zero amount as zero", () => {
    expect(formatMoney(150)).toBe("$0.0002");
    expect(formatMoney(149)).toBe("$0.0001");
    expect(formatMoney(-150)).toBe("-$0.0002");
    expect(formatMoney(49)).toBe("Less than $0.0001");
    expect(formatMoney(-49)).toBe("-Less than $0.0001");
  });

  // #505-T05
  it("writes a price like an amount, without a sign", () => {
    expect(formatPrice(1_820_000)).toBe("$1.82");
    expect(formatPrice(13_000)).toBe("$0.013");
    expect(formatPrice(0)).toBe("$0.00");
  });
});

describe("a typed top-up amount", () => {
  // #505-T03
  it.each([
    ["10", 1_000],
    ["25.50", 2_550],
    ["500", 50_000],
    [" 100 ", 10_000],
    ["12.5", 1_250],
    ["$25", 2_500],
    ["1,000", null],
  ])("reads %j as %s cents", (text, cents) => {
    const result = parseTopUpCents(text);
    expect(result.ok ? result.cents : null).toBe(cents);
  });

  // #505-T03
  it.each([
    ["", "amount_invalid"],
    ["abc", "amount_invalid"],
    ["10.123", "amount_invalid"],
    ["-5", "amount_invalid"],
    ["9.99", "amount_out_of_range"],
    ["500.01", "amount_out_of_range"],
    ["0", "amount_out_of_range"],
  ])("refuses %j with %s", (text, code) => {
    expect(parseTopUpCents(text)).toEqual({ ok: false, error: code });
  });

  // #505-T03
  it("states the range of ADR 0006", () => {
    expect([TOP_UP_MIN_CENTS, TOP_UP_MAX_CENTS]).toEqual([1_000, 50_000]);
  });
});

describe("a signed amount of the journal", () => {
  // #505-T01
  it.each([
    [10_000_000, "+$10.00"],
    [-1_630_000, "-$1.63"],
    [0, "$0.00"],
  ])("writes %i micro-USD as %s", (micro, text) => {
    expect(formatSignedMoney(micro)).toBe(text);
  });
});

describe("a typed monthly limit", () => {
  // #505-T09
  it.each([
    ["250", 25_000],
    ["1", 100],
    ["1000000", 100_000_000],
    ["12.34", 1_234],
    ["$40", 4_000],
  ])("reads %j as %i cents", (text, cents) => {
    expect(parseLimitCents(text)).toEqual({ ok: true, cents });
  });

  // #505-T09
  it("reads an empty field as no limit", () => {
    expect(parseLimitCents("")).toEqual({ ok: true, cents: null });
    expect(parseLimitCents("   ")).toEqual({ ok: true, cents: null });
  });

  // #505-T09
  it.each([
    ["0.99", "limit_out_of_range"],
    ["0", "limit_out_of_range"],
    ["1000000.01", "limit_out_of_range"],
    ["lots", "limit_invalid"],
    ["-5", "limit_invalid"],
    ["1.234", "limit_invalid"],
  ])("refuses %j with %s", (text, error) => {
    expect(parseLimitCents(text)).toEqual({ ok: false, error });
  });

  // #505-T09
  it("states the bounds the server judges", () => {
    expect([MONTHLY_LIMIT_MIN_CENTS, MONTHLY_LIMIT_MAX_CENTS]).toEqual([
      100, 100_000_000,
    ]);
  });
});

describe("the amount of an invoice", () => {
  // #659-T01
  it("is written from the provider's cents in the currency of the invoice", () => {
    expect(formatInvoiceAmount(2500, "usd")).toBe("$25.00");
    expect(formatInvoiceAmount(123456, "usd")).toBe("$1,234.56");
    expect(formatInvoiceAmount(2500, "eur")).toBe("€25.00");
    expect(formatInvoiceAmount(2500, "jpy")).toBe("¥2,500");
  });

  // #659-T01
  it("falls back to the number and the code for a currency the runtime does not know", () => {
    expect(formatInvoiceAmount(2500, "zzz")).toMatch(/25|2500/);
  });
});
