// SPDX-License-Identifier: LicenseRef-Proprietary

// The decimals the billing page shows and takes (#504): dollars to micro-USD (1 USD = 1,000,000) and back, the factor A to parts
// per 10,000 and back, and whole numbers. No floating point touches an amount: a text is split at its decimal point and read as
// digits, so 0.013 is 13,000 and not 12,999.999. A text that is not exactly a decimal of the right number of places is refused
// (null), never rounded: the server judges the bounds. Pure and free of server code, because the page is a client component.

function digitsToNumber(whole: string, fraction: string, places: number) {
  const padded = fraction.padEnd(places, "0");
  const value = Number(`${whole === "" ? "0" : whole}${padded}`);
  return Number.isSafeInteger(value) ? value : null;
}

function parseDecimal(
  text: string,
  places: number,
  signed: boolean,
): number | null {
  const match = (
    signed ? /^([+-]?)(\d*)(?:\.(\d*))?$/ : /^()(\d*)(?:\.(\d*))?$/
  ).exec(text.trim());
  if (match === null) return null;
  const [, sign = "", whole = "", fraction = ""] = match;
  // A bare "." or "" has no digit.
  if (whole === "" && fraction === "") return null;
  if (fraction.length > places) return null;
  const value = digitsToNumber(whole, fraction, places);
  if (value === null) return null;
  return sign === "-" ? -value : value;
}

/** US dollars as text to micro-USD, or null when it is no amount of at most six decimals. `signed` also takes `-` and `+`. */
export function parseUsd(
  text: string,
  options: { signed?: boolean } = {},
): number | null {
  const micro = parseDecimal(text, 6, options.signed === true);
  return micro === null ? null : micro + 0;
}

/** The factor A as text (`1.2`) to parts per 10,000 (12,000), or null when it has more than four decimals. */
export function parseFactor(text: string): number | null {
  return parseDecimal(text, 4, false);
}

/** A whole number as text, or null. */
export function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function writeDecimal(
  value: number,
  places: number,
  minPlaces: number,
): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  let fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  fraction = fraction.padEnd(minPlaces, "0");
  const text = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Micro-USD as the shortest decimal: 13,000 is `0.013`, 2,000,000 is `2`. */
export function formatUsd(micro: number): string {
  return writeDecimal(micro, 6, 0);
}

/** Micro-USD with at least two decimals, for a balance: 8,000,000 is `8.00`, 13,000 is `0.013`. */
export function formatUsdFixed(micro: number): string {
  return writeDecimal(micro, 6, 2);
}

/** Parts per 10,000 as the shortest decimal: 12,000 is `1.2`. */
export function formatFactor(parts: number): string {
  return writeDecimal(parts, 4, 0);
}
