// SPDX-License-Identifier: Apache-2.0

// The price input of the plan form (#438, ADR 0005, 2.11): dollars and cents typed as text, kept as integers in minor
// units (cents). No floating point anywhere: the text is split, never multiplied. Pure, so the form and the server
// share it. An amount is admin data; nothing here knows one.

/**
 * The highest price of a plan version: 1,000,000 USD in cents. The columns are `integer` (int4 on Postgres, at most
 * 2,147,483,647 minor units), and no plan costs this much; the bound keeps a typo from reaching the database, which would
 * answer "out of range" and the route a generic 503. Shared by the form and the validation of the service.
 */
export const PRICE_MAX_MINOR = 100_000_000;

/** At most nine digits before the point, so the text becomes a number safely; the bound above is checked after. */
const USD_TEXT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

export type UsdParse = { ok: true; minor: number | null } | { ok: false };

/**
 * "9.99" is 999, "10" is 1000, "10.5" is 1050. An empty field is `null` (no price: for the yearly price, no yearly
 * option). Anything else that is not dollars with at most two decimals ("9.999", "-5", "abc", "1,000", "$10") is
 * refused, and so is an amount above `PRICE_MAX_MINOR`. Zero parses (it is a number); the validation of a version refuses it as a price.
 */
export function parseUsdToMinor(text: string): UsdParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, minor: null };
  const match = USD_TEXT.exec(trimmed);
  if (match === null) return { ok: false };
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = dollars * 100 + cents;
  // Above the bound is no price (the same refusal as an amount that is not dollars and cents).
  if (minor > PRICE_MAX_MINOR) return { ok: false };
  return { ok: true, minor };
}

/** Minor units as the text an input holds: 999 is "9.99", 1000 is "10.00". */
export function formatMinorAsUsd(minor: number): string {
  const dollars = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}

/** Cost limits are micro-USD of measured model cost, so their input takes up to six decimals. */
const USD_MICRO_TEXT = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

export type MicroParse = { ok: true; micro: number | null } | { ok: false };

/** "3" is 3,000,000, "2.5" is 2,500,000, "0.000001" is 1; an empty field is `null` (no limit). */
export function parseUsdToMicro(text: string): MicroParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, micro: null };
  const match = USD_MICRO_TEXT.exec(trimmed);
  if (match === null) return { ok: false };
  const dollars = Number(match[1]);
  const micro = Number((match[2] ?? "").padEnd(6, "0"));
  return { ok: true, micro: dollars * 1_000_000 + micro };
}

/** Micro-USD as the text an input holds, with at least two decimals and no digit lost. */
export function formatMicroAsUsd(micro: number): string {
  const dollars = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${dollars}.${fraction}`;
}
