// SPDX-License-Identifier: Apache-2.0

// Verifies the `Stripe-Signature` header of a webhook (ADR 0006, 2.13): `t=<unix seconds>,v1=<hex>[,v1=<hex>][,v0=...]`,
// where each `v1` is the HMAC-SHA256 of `<t>.<raw body>` made with the secret of the webhook endpoint (`whsec_...`).
// Our own check, not the SDK's: it takes the body as the bytes that were received, accepts several `v1` values (Stripe
// sends two while a secret is being rotated), compares every one of them in constant time, checks the signature BEFORE
// the age (a message with a bad signature never learns whether it was also old) and takes the tolerance as an explicit
// parameter. Unlike the SDK it also refuses a timestamp too far in the future. Replay inside the tolerance is stopped by
// the dedupe on the event id, not by the clock. Pure: the body, the secret and the time come in, a verdict comes out;
// nothing is logged and the verdict never carries the header, the body or the secret.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/** The default: five minutes either way, Stripe's own default; room for clock skew, short enough to bound a replay. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export const STRIPE_SIGNATURE_ERROR_CODES = [
  "secret_missing",
  "signature_missing",
  "signature_malformed",
  "signature_mismatch",
  "timestamp_out_of_tolerance",
  "tolerance_invalid",
] as const;
export type StripeSignatureErrorCode =
  (typeof STRIPE_SIGNATURE_ERROR_CODES)[number];

export type StripeSignatureVerdict =
  | { ok: true; timestamp: number }
  | { ok: false; code: StripeSignatureErrorCode };

const DIGITS = /^\d{1,12}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

type ParsedHeader = { timestamp: number; digests: Buffer[] };

/**
 * Null when the header is not one `t=<digits>` plus at least one well formed `v1`. Other schemes (`v0`, and any a later
 * version adds) are ignored; a part that is no `key=value` is not.
 */
function parseHeader(header: string): ParsedHeader | null {
  const timestamps: string[] = [];
  const digests: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamps.push(value);
    if (key === "v1") {
      if (!SHA256_HEX.test(value)) return null;
      digests.push(Buffer.from(value, "hex"));
    }
  }
  const [timestamp, ...extra] = timestamps;
  if (timestamp === undefined || extra.length > 0 || !DIGITS.test(timestamp))
    return null;
  if (digests.length === 0) return null;
  return { timestamp: Number(timestamp), digests };
}

export function verifyStripeSignature(input: {
  header: string | null | undefined;
  /** The body exactly as it arrived, before any decoding or JSON parse. Text is taken as its UTF-8 bytes. */
  rawBody: Uint8Array | string;
  secret: string;
  now: Date;
  /** How far `t` may be from `now`, either way. Default `STRIPE_SIGNATURE_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
}): StripeSignatureVerdict {
  // An empty key would make a signature that anybody can compute.
  if (input.secret === "") return { ok: false, code: "secret_missing" };
  // `NaN` would make every age pass the comparison below, and a negative number would refuse every one.
  const tolerance =
    input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    return { ok: false, code: "tolerance_invalid" };
  const header = input.header?.trim();
  if (header === undefined || header === "")
    return { ok: false, code: "signature_missing" };
  const parsed = parseHeader(header);
  if (parsed === null) return { ok: false, code: "signature_malformed" };

  const expected = createHmac("sha256", input.secret)
    .update(`${parsed.timestamp}.`)
    .update(input.rawBody)
    .digest();
  // Every candidate is compared, none is skipped after a match, so the time does not tell which one fit.
  let matched = false;
  for (const candidate of parsed.digests)
    if (timingSafeEqual(candidate, expected)) matched = true;
  if (!matched) return { ok: false, code: "signature_mismatch" };

  const ageSeconds = input.now.getTime() / 1000 - parsed.timestamp;
  // Written so that a `NaN` age (an invalid `now`) is refused: `NaN > tolerance` would be false.
  if (!(Math.abs(ageSeconds) <= tolerance))
    return { ok: false, code: "timestamp_out_of_tolerance" };
  return { ok: true, timestamp: parsed.timestamp };
}
