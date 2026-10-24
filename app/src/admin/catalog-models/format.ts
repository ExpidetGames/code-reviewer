// SPDX-License-Identifier: LicenseRef-Proprietary

// What the catalog screens do with text and numbers (#554). Client safe. Every string from models.dev is untrusted text:
// React escapes what is rendered, a long one is cut where it is shown, and an address becomes a link only after the check
// below.
import {
  microUsdPerMTokToUsd,
  usdPerMTokToMicroUsd,
} from "../../model-prices/money.ts";

const WHOLE_NUMBER = /^\d{1,12}$/;

/** A price in whole micro-USD per million tokens as exact dollars, at least two decimals ("$2.50", "$0.0375"); "–" when it is none. */
export function formatUsdPerMTok(microUsd: string): string {
  if (!WHOLE_NUMBER.test(microUsd)) return "–";
  const exact = microUsdPerMTokToUsd(BigInt(microUsd));
  const [whole = "0", fraction = ""] = exact.split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}

/** The USD text a price field is typed as, checked: the micro-USD of a decimal text, or null. Re-exported for the form. */
export const microUsdOf = usdPerMTokToMicroUsd;

/** A text cut to `max` characters (not bytes, not UTF-16 units) with an ellipsis in place of the last one. */
export function truncateText(
  text: string,
  max: number,
): { text: string; cut: boolean } {
  const characters = Array.from(text);
  if (characters.length <= max) return { text, cut: false };
  return { text: `${characters.slice(0, max - 1).join("")}…`, cut: true };
}

/** Characters a reader does not see: control, format (bidi marks, zero-width), line and paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A text with its invisible characters left out: for a text that is only shown (a refused address), never one that is acted on. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** A text with each invisible character written as `\u{XXXX}`: for a text that is acted on, so what is read is what is sent. */
export function escapeInvisible(text: string): string {
  return text.replace(
    INVISIBLE,
    (character) =>
      `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/**
 * The address to put in a link, or null: only `https`, with a host, without credentials, whitespace or control characters.
 * `javascript:`, `data:`, `http:` and relative addresses are never links; the page shows them as text.
 */
export function safeHttpsHref(address: string): string | null {
  if (/[\s\p{Cc}]/u.test(address)) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}
