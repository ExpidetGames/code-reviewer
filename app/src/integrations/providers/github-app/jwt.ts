// SPDX-License-Identifier: LicenseRef-Proprietary

// Signs the short-lived JWT that authenticates the app itself to GitHub (RS256, `iss` is the app id).
import { createSign } from "node:crypto";

const JWT_VALIDITY_SECONDS = 600;
/** GitHub rejects a JWT issued in its future; backdating covers small clock differences. */
const CLOCK_SKEW_SECONDS = 60;

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** `nowMs` is the clock in milliseconds since the epoch; injected so tests need no real time. */
export function createAppJwt(options: {
  appId: string;
  privateKey: string;
  nowMs: number;
}): string {
  const now = Math.floor(options.nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - CLOCK_SKEW_SECONDS,
      exp: now + JWT_VALIDITY_SECONDS - CLOCK_SKEW_SECONDS,
      iss: options.appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(options.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}
