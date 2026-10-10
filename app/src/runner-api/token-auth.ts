// The shared secret of the runner API. One token for every runner in the MVP, set as RUNNER_TOKEN.
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The shortest `RUNNER_TOKEN` that is accepted. There is no rate limit on failed attempts, so the
 * token has to be strong enough to need none (`openssl rand -hex 32` gives 64 characters).
 */
export const MIN_RUNNER_TOKEN_LENGTH = 32;

/** The configured token as it is used: surrounding white space (a trailing newline) is not part of it. */
export function configuredRunnerToken(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const token = env.RUNNER_TOKEN?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/**
 * Compares the configured token with the one a request carried, in constant time for any lengths
 * and characters: both sides are hashed first, so the comparison always works on two buffers of
 * the same size and never throws. A missing, blank or too short (under 32 characters) configured
 * token never matches anything: the API is not open when the setting is forgotten or weak.
 */
export function tokensMatch(
  configured: string | undefined,
  provided: string,
): boolean {
  const expected = configured?.trim();
  if (expected === undefined || expected.length < MIN_RUNNER_TOKEN_LENGTH)
    return false;
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
