// SPDX-License-Identifier: LicenseRef-Proprietary

// Verifies the signature of the dispatch webhook (contracts/dispatch-webhook.v1.json): the Dispatcher's
// own implementation, proven against the shared vectors (contracts/dispatch-signing-vectors.json) and the
// reference verifier of the fakes. The order is the contract's: form, clock, key id, signature.
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerdict =
  "ok" | "malformed" | "expired" | "unknown_key" | "bad_signature";

export type SigningKey = { kid: string; secret: string };

const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

/** `v1=` and the hexadecimal HMAC-SHA-256 over `v1:{timestamp}:{dispatchId}:{rawBody}`. */
export function sign(input: {
  secret: string;
  timestamp: string;
  dispatchId: string;
  rawBody: string;
}): string {
  const message = `v1:${input.timestamp}:${input.dispatchId}:${input.rawBody}`;
  return `v1=${createHmac("sha256", input.secret).update(message, "utf8").digest("hex")}`;
}

/** The verdict for a request as the receiver sees it; `headers` are keyed by lower case name. */
export function verifyDispatchSignature(input: {
  keys: readonly SigningKey[];
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds: number;
}): SignatureVerdict {
  const timestamp = input.headers["x-dispatch-timestamp"];
  const dispatchId = input.headers["x-dispatch-id"];
  const signature = input.headers["x-dispatch-signature"];
  const keyId = input.headers["x-dispatch-key-id"];
  if (
    timestamp === undefined ||
    dispatchId === undefined ||
    dispatchId === "" ||
    signature === undefined ||
    keyId === undefined ||
    !TIMESTAMP.test(timestamp) ||
    !SIGNATURE.test(signature)
  )
    return "malformed";
  if (Math.abs(Number(timestamp) - input.nowSeconds) > input.toleranceSeconds)
    return "expired";
  const key = input.keys.find((candidate) => candidate.kid === keyId);
  if (key === undefined) return "unknown_key";
  const expected = Buffer.from(
    sign({ secret: key.secret, timestamp, dispatchId, rawBody: input.rawBody }),
  );
  const received = Buffer.from(signature);
  return expected.length === received.length &&
    timingSafeEqual(expected, received)
    ? "ok"
    : "bad_signature";
}
