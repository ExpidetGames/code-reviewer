// SPDX-License-Identifier: LicenseRef-Proprietary

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

// The three functions below make, recognize and hash a 256 bit link token of any kind. The reset links
// (here) and the verification links of an email address (src/signup/verification-tokens.ts) are made the
// same way, so they share this code.

/** 256 random bits, spelled base64url. */
export function newLinkToken(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return Buffer.from(random(TOKEN_BYTES)).toString("base64url");
}

/** Whether a value is shaped like a link token (the shape only; it says nothing about whether it exists). */
export function isWellFormedLinkToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** The SHA-256 hash (hex) that is stored instead of the token. */
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const newResetToken = newLinkToken;
export const isWellFormedResetToken = isWellFormedLinkToken;
export const hashResetToken = hashLinkToken;
