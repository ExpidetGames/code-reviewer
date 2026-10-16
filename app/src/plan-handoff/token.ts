// SPDX-License-Identifier: Apache-2.0

// The handoff token: 256 random bits as 43 base64url characters. It travels once, in the redirect to the
// operator-configured page, and the database keeps only its SHA-256 hash.
import { createHash, randomBytes } from "node:crypto";

/** How long a handoff token can be redeemed after it was made. */
export const HANDOFF_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 32 bytes in base64url, no padding. */
const WELL_FORMED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createHandoffToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashHandoffToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether `token` can be one this app made. Anything else is refused without a lookup. */
export function isWellFormedHandoffToken(token: unknown): token is string {
  return typeof token === "string" && WELL_FORMED_TOKEN.test(token);
}
