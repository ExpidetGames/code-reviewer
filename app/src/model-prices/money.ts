// SPDX-License-Identifier: LicenseRef-Proprietary

// Prices as whole numbers (#549). A price is USD per million tokens, as models.dev states it (an exact decimal string).
// The app holds it as BigInt micro-USD per million tokens, the unit of `src/billing/` (one micro-USD is a millionth of a
// US dollar), so USD 2.50 per million tokens is 2,500,000. No float takes part: a text is read digit by digit, and a
// price finer than one micro-USD per million tokens is refused instead of rounded, because a rounded price would be a
// charge nobody confirmed. Client safe.

/** USD 100,000 per million tokens: far above any real price, the bound `parse.ts` puts on a catalog price too. */
const MICRO = BigInt(1_000_000);

export const MAX_PRICE_MICRO_USD_PER_MTOK = BigInt(100_000) * MICRO;

const DECIMAL = /^(\d{1,9})(?:\.(\d{1,12}))?$/;

/** USD per million tokens as a decimal text to micro-USD per million tokens; null when it is none or not exact. */
export function usdPerMTokToMicroUsd(text: string): bigint | null {
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  // Beyond the sixth decimal only zeros are the same number.
  if (/[^0]/.test(fraction.slice(6))) return null;
  const micro =
    BigInt(whole) * MICRO + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  return micro > MAX_PRICE_MICRO_USD_PER_MTOK ? null : micro;
}

/** Micro-USD per million tokens as the shortest exact decimal text of USD per million tokens. */
export function microUsdPerMTokToUsd(value: bigint): string {
  const whole = value / MICRO;
  const fraction = (value % MICRO)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}
