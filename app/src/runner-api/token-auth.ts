// SPDX-License-Identifier: LicenseRef-Proprietary

// The shared secret of the runner API. One token for every runner in the MVP, set as RUNNER_TOKEN.
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The shortest `RUNNER_TOKEN` that is accepted. There is no rate limit on failed attempts, so the
 * token has to be strong enough to need none (`openssl rand -hex 32` gives 64 characters).
 */
export const MIN_RUNNER_TOKEN_LENGTH = 32;

// Same rule as the runner's own settings (runner/.../job_loop/settings.py): a token with white space or
// a non-printable character inside is refused there, so it must not count as usable here either, or
// the app would start and the runner would crash-loop. (Python's isprintable is false for the
// categories C and Z, except the plain space, which is white space anyway.)
export const UNUSABLE_CHARACTER = /[\s\p{C}\p{Z}]/u;

type Env = Readonly<Record<string, string | undefined>>;

function trimmedToken(env: Env): string | undefined {
  const token = env.RUNNER_TOKEN?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/**
 * What is wrong with the configured `RUNNER_TOKEN`, as a phrase that follows its name ("RUNNER_TOKEN
 * is not set"), or null when it is usable. The one judgement of the start checks (deploy/startup.ts
 * and runner-api/startup.ts) and of {@link configuredRunnerToken}.
 */
export function runnerTokenProblem(env: Env): string | null {
  const token = trimmedToken(env);
  if (token === undefined) return "is not set";
  if (UNUSABLE_CHARACTER.test(token))
    return "must not contain white space or control characters";
  if (token.length < MIN_RUNNER_TOKEN_LENGTH)
    return `must be at least ${String(MIN_RUNNER_TOKEN_LENGTH)} characters long`;
  return null;
}

/**
 * The configured token as it is used: surrounding white space (a trailing newline) is not part of it,
 * and a token the runner would refuse (white space or control characters inside) counts as not set.
 */
export function configuredRunnerToken(env: Env): string | undefined {
  const token = trimmedToken(env);
  return token === undefined || UNUSABLE_CHARACTER.test(token)
    ? undefined
    : token;
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
