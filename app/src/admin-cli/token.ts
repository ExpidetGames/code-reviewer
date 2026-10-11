// SPDX-License-Identifier: Apache-2.0

// The reset token of a password reset link (docs/decisions/0001-editions-setup-and-accounts.md, sections
// 2.3 and 2.7): 256 random bits, spelled base64url so it is safe in a link, valid for 30 minutes, used
// once. Only its SHA-256 hash is ever stored (`password_reset_tokens.token_hash`), so a copy of the
// database cannot reset a password.
//
// Shared by the command line that prints a link (cli.ts) and by the app that accepts one
// (src/auth/password-reset.ts). The command line runs without Next.js, so this file imports only Node.
import { createHash, randomBytes } from "node:crypto";

/** How long a link works. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const TOKEN_BYTES = 32;
// 32 bytes in base64url, without padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newResetToken(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return Buffer.from(random(TOKEN_BYTES)).toString("base64url");
}

export function isWellFormedResetToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
