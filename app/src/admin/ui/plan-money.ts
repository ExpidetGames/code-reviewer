// SPDX-License-Identifier: Apache-2.0

// The price input of the plan form (#438, ADR 0005, 2.11): dollars and cents typed as text, kept as integers in minor
// units (cents). No floating point anywhere: the text is split, never multiplied. Pure, so the form and the server
// share it. An amount is admin data; nothing here knows one.

/** At most nine digits before the point: far below a safe integer in cents, far above any plan. */
const USD_TEXT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

export type UsdParse = { ok: true; minor: number | null } | { ok: false };

/**
 * "9.99" is 999, "10" is 1000, "10.5" is 1050. An empty field is `null` (no price: for the yearly price, no yearly
 * option). Anything else that is not dollars with at most two decimals ("9.999", "-5", "abc", "1,000", "$10") is
 * refused. Zero parses (it is a number); the validation of a version refuses it as a price.
 */
export function parseUsdToMinor(text: string): UsdParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, minor: null };
  const match = USD_TEXT.exec(trimmed);
  if (match === null) return { ok: false };
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return { ok: true, minor: dollars * 100 + cents };
}

/** Minor units as the text an input holds: 999 is "9.99", 1000 is "10.00". */
export function formatMinorAsUsd(minor: number): string {
  const dollars = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}
