// SPDX-License-Identifier: Apache-2.0

// Verifies the `Paddle-Signature` header of a webhook (ADR 0005, 2.12): `ts=<unix seconds>;h1=<hex>`, where `h1`
// is the HMAC-SHA256 of `<ts>:<raw body>` made with the secret of the notification destination. Our own check, not
// the SDK's: it accepts several `h1` values (Paddle sends more than one while a secret is rotated), compares in
// constant time and allows a tolerance of minutes, not seconds. Replay is stopped by the dedupe on `event_id`,
// not by the clock. The tolerance is a parameter (`toleranceSeconds`): the default suits a `ts` that Paddle makes
// fresh for each try; if the sandbox shows that a retry keeps the `ts` of the first try (research S3), the caller
// widens it to cover the retry window, and the signature still binds the body. Pure: the body, the secret and the
// time come in, a verdict comes out; nothing is logged.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The default: five minutes either way, room for clock skew and a cold start, short enough to bound a replayed
 * header. It assumes Paddle signs each retry with a fresh `ts`; that is unverified (research S3, sandbox).
 */
export const PADDLE_SIGNATURE_TOLERANCE_SECONDS = 300;

export const PADDLE_SIGNATURE_ERROR_CODES = [
  "secret_missing",
  "signature_missing",
  "signature_malformed",
  "signature_mismatch",
  "timestamp_out_of_tolerance",
  "tolerance_invalid",
] as const;
export type PaddleSignatureErrorCode =
  (typeof PADDLE_SIGNATURE_ERROR_CODES)[number];

export type PaddleSignatureVerdict =
  | { ok: true; timestamp: number }
  | { ok: false; code: PaddleSignatureErrorCode };

const DIGITS = /^\d{1,12}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

type ParsedHeader = { timestamp: number; digests: Buffer[] };

/** Null when the header is not `ts=<digits>` plus at least one well formed `h1`. Unknown keys are ignored. */
function parseHeader(header: string): ParsedHeader | null {
  const timestamps: string[] = [];
  const digests: Buffer[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "ts") timestamps.push(value);
    if (key === "h1") {
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

export function verifyPaddleSignature(input: {
  header: string | null | undefined;
  /** The body exactly as it arrived, before any JSON parse. */
  rawBody: string;
  secret: string;
  now: Date;
  /** How far `ts` may be from `now`, either way. Default `PADDLE_SIGNATURE_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
}): PaddleSignatureVerdict {
  // An empty key would make a signature that anybody can compute.
  if (input.secret === "") return { ok: false, code: "secret_missing" };
  // `NaN` would make every age pass the comparison below, and a negative number would refuse every one.
  const tolerance =
    input.toleranceSeconds ?? PADDLE_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    return { ok: false, code: "tolerance_invalid" };
  const header = input.header?.trim();
  if (header === undefined || header === "")
    return { ok: false, code: "signature_missing" };
  const parsed = parseHeader(header);
  if (parsed === null) return { ok: false, code: "signature_malformed" };

  const expected = createHmac("sha256", input.secret)
    .update(`${parsed.timestamp}:${input.rawBody}`)
    .digest();
  // Every candidate is compared, none is skipped after a match, so the time does not tell which one fit.
  let matched = false;
  for (const candidate of parsed.digests)
    if (timingSafeEqual(candidate, expected)) matched = true;
  if (!matched) return { ok: false, code: "signature_mismatch" };

  const ageSeconds = input.now.getTime() / 1000 - parsed.timestamp;
  if (Math.abs(ageSeconds) > tolerance)
    return { ok: false, code: "timestamp_out_of_tolerance" };
  return { ok: true, timestamp: parsed.timestamp };
}
