// SPDX-License-Identifier: Apache-2.0

// Prices as whole numbers (#549): USD per million tokens, written as the exact decimal strings models.dev gives, become
// BigInt micro-USD per million tokens. No float is ever part of it.
import { describe, expect, it } from "vitest";
import {
  MAX_PRICE_MICRO_USD_PER_MTOK,
  microUsdPerMTokToUsd,
  usdPerMTokToMicroUsd,
} from "./money.ts";

describe("usdPerMTokToMicroUsd", () => {
  // #549-T10
  it.each([
    ["0", 0n],
    ["2", 2_000_000n],
    ["12.5", 12_500_000n],
    ["0.003", 3_000n],
    ["0.000001", 1n],
    ["0.250000000000", 250_000n],
    ["100000", 100_000_000_000n],
  ])("reads %s exactly", (text, micro) => {
    expect(usdPerMTokToMicroUsd(text)).toBe(micro);
  });

  // #549-T10
  it.each([
    "",
    "-1",
    "1e3",
    "NaN",
    "Infinity",
    " 1",
    "1 ",
    "1,5",
    ".5",
    "5.",
    "0x10",
    "+1",
    "0.0000001",
    "100000.000001",
    "1000000",
    "1.2.3",
  ])("refuses %j", (text) => {
    expect(usdPerMTokToMicroUsd(text)).toBeNull();
  });

  it("keeps the bound as a whole number of micro-USD", () => {
    expect(MAX_PRICE_MICRO_USD_PER_MTOK).toBe(100_000_000_000n);
  });
});

describe("microUsdPerMTokToUsd", () => {
  it("writes the shortest exact decimal", () => {
    expect(microUsdPerMTokToUsd(0n)).toBe("0");
    expect(microUsdPerMTokToUsd(2_000_000n)).toBe("2");
    expect(microUsdPerMTokToUsd(12_500_000n)).toBe("12.5");
    expect(microUsdPerMTokToUsd(3_000n)).toBe("0.003");
    expect(microUsdPerMTokToUsd(1n)).toBe("0.000001");
  });

  it("round-trips every price the catalog states", () => {
    for (const text of ["0.1", "0.625", "10", "27.5", "0.000123"])
      expect(microUsdPerMTokToUsd(usdPerMTokToMicroUsd(text) as bigint)).toBe(
        text,
      );
  });
});
