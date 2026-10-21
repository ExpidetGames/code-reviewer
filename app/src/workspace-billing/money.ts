// SPDX-License-Identifier: Apache-2.0

// Money on the billing page of a workspace (#505). Amounts arrive as whole micro-USD (1 USD = 1,000,000) and leave as text;
// a typed top-up amount comes back as whole US cents, the unit the top-up route takes. Pure and free of server code, because the
// page is a client component. No floating point touches an amount: every step is integer arithmetic on safe integers.
//
// DISPLAY ROUNDING (documented here and in src/billing/README.md): an amount is shown rounded half away from zero to four
// decimals, with at least two decimals (so 5,000,000 is `$5.00` and 7,981,800 is `$7.9818`), and a non-zero amount that would
// round to zero is shown as "Less than $0.0001". Nothing is stored rounded: the journal keeps the exact micro-USD amount, and a
// total in the journal can differ from the sum of the rounded rows by less than one ten-thousandth of a dollar per row.

/** The top-up range of ADR 0006: 10 to 500 US dollars, in cents. */
export const TOP_UP_MIN_CENTS = 1_000;
export const TOP_UP_MAX_CENTS = 50_000;

const MICRO_PER_FOURTH_DECIMAL = 100;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The magnitude of an amount as `1,234.5` (at least two decimals, at most four), or null when it rounds to zero but is not zero. */
function magnitudeText(magnitude: number): string | null {
  if (magnitude === 0) return "0.00";
  const fourths = Math.floor(
    (magnitude + MICRO_PER_FOURTH_DECIMAL / 2) / MICRO_PER_FOURTH_DECIMAL,
  );
  if (fourths === 0) return null;
  const whole = Math.floor(fourths / 10_000);
  const fraction = String(fourths % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${groupThousands(String(whole))}.${fraction}`;
}

/** An amount of the balance or the journal: `$7.98`, `-$0.50`, `Less than $0.0001`. */
export function formatMoney(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const text = magnitudeText(Math.abs(micro));
  return text === null ? `${sign}Less than $0.0001` : `${sign}$${text}`;
}

/** The price of a review or of a part of it: an amount that is never negative. */
export function formatPrice(micro: number): string {
  return formatMoney(Math.max(0, micro));
}

export type TopUpAmount =
  | { ok: true; cents: number }
  | { ok: false; error: "amount_invalid" | "amount_out_of_range" };

/**
 * A typed top-up amount in US dollars (`25`, `25.5`, `$25.50`) as whole cents. More than two decimals, a sign, a thousands
 * separator or any other text is `amount_invalid`; an amount outside 10 to 500 US dollars is `amount_out_of_range`. The server
 * judges the amount again.
 */
export function parseTopUpCents(text: string): TopUpAmount {
  const match = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return { ok: false, error: "amount_invalid" };
  const [, whole = "", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: "amount_invalid" };
  if (cents < TOP_UP_MIN_CENTS || cents > TOP_UP_MAX_CENTS)
    return { ok: false, error: "amount_out_of_range" };
  return { ok: true, cents };
}
