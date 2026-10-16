// SPDX-License-Identifier: Apache-2.0

// The reference signer and verifier of the dispatch webhook (contracts/dispatch-webhook.v1.json), shared
// by the tests of every TypeScript project that touches it. The real sender (the app) and the real
// receiver (the Dispatcher) have their own code and must give the same verdicts for the vectors in
// contracts/dispatch-signing-vectors.json; this file is what those vectors are proven against. Node
// runs it as it is (type stripping): relative imports with the extension, no TypeScript-only runtime
// syntax.
import { createHmac, timingSafeEqual } from "node:crypto";

export type DispatchVerdict =
  "ok" | "malformed" | "expired" | "unknown_key" | "bad_signature";

export type DispatchKey = { kid: string; secret: string };

/** The signature header value for a request: `v1=` and the hexadecimal HMAC-SHA-256. */
export function signDispatch(input: {
  secret: string;
  timestamp: string;
  dispatchId: string;
  rawBody: string;
}): string {
  const message = `v1:${input.timestamp}:${input.dispatchId}:${input.rawBody}`;
  return `v1=${createHmac("sha256", input.secret).update(message, "utf8").digest("hex")}`;
}

const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

/**
 * The verdict for a request as a receiver sees it. Header names are lower case. The order is the one
 * in the contract: form, clock, key id, signature (constant time).
 */
export function verifyDispatch(input: {
  keys: DispatchKey[];
  headers: Record<string, string | undefined>;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds: number;
}): DispatchVerdict {
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
    signDispatch({
      secret: key.secret,
      timestamp,
      dispatchId,
      rawBody: input.rawBody,
    }),
  );
  const received = Buffer.from(signature);
  return expected.length === received.length &&
    timingSafeEqual(expected, received)
    ? "ok"
    : "bad_signature";
}
