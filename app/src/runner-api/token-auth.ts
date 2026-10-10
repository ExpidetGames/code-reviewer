// The shared secret of the runner API. One token for every runner in the MVP, set as RUNNER_TOKEN.
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares the configured token with the one a request carried, in constant time for any lengths
 * and characters: both sides are hashed first, so the comparison always works on two buffers of
 * the same size and never throws. A missing, empty or blank configured token never matches
 * anything: the API is not open when the setting is forgotten.
 */
export function tokensMatch(
  expected: string | undefined,
  provided: string,
): boolean {
  if (expected === undefined || expected.trim() === "") return false;
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/**
 * The token of an `Authorization: Bearer <token>` header, or null if the header is missing, uses
 * another scheme or carries no token. The scheme is not case sensitive; the token is everything
 * after it, unchanged.
 */
export function bearerTokenOf(header: string | null): string | null {
  if (header === null) return null;
  const match = /^bearer[ \t]+(\S.*)$/i.exec(header);
  const token = match?.[1];
  return token === undefined || token.trim() === "" ? null : token;
}
