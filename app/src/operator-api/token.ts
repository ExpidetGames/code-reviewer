// SPDX-License-Identifier: Apache-2.0

// The credential of the operator API: one bearer token, `OPERATOR_API_TOKEN`. It follows the strength rules of
// `RUNNER_TOKEN` (at least 32 characters, no white space or control characters) and must differ from the
// runner token and from the master key, so that leaking one credential does not open the others. A token that is
// not set or not usable means the API does not exist (see README.md): `configuredOperatorToken` is then
// undefined. Nothing here ever puts a token value into a message.
import "server-only";
import {
  MIN_RUNNER_TOKEN_LENGTH,
  UNUSABLE_CHARACTER,
  tokensMatch,
} from "../runner-api/token-auth.ts";

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/**
 * What is wrong with a configured `OPERATOR_API_TOKEN`, as a phrase that follows its name ("must differ from
 * RUNNER_TOKEN"), or null when it is usable or not set at all (the normal case: the API is off and nothing
 * is wrong).
 */
export function operatorTokenProblem(env: Env): string | null {
  const token = trimmed(env.OPERATOR_API_TOKEN);
  if (token === undefined) return null;
  if (UNUSABLE_CHARACTER.test(token))
    return "must not contain white space or control characters";
  if (token.length < MIN_RUNNER_TOKEN_LENGTH)
    return `must be at least ${String(MIN_RUNNER_TOKEN_LENGTH)} characters long`;
  return operatorTokenReuseProblem(env);
}

/**
 * The part of the problem that ends a production start (src/deploy/startup.ts): the token is the same as the runner
 * token or the master key. A merely weak token only keeps the API off and is reported by a warning.
 */
export function operatorTokenReuseProblem(env: Env): string | null {
  const token = trimmed(env.OPERATOR_API_TOKEN);
  if (token === undefined) return null;
  if (token === trimmed(env.RUNNER_TOKEN))
    return "must differ from RUNNER_TOKEN";
  // Either variable is a secret of the instance. BETTER_AUTH_SECRET is the master key while APP_SECRET is not set
  // (src/crypto/app-secret.ts) and stays a credential of its own while both are set (sessions and stored tokens
  // made with it, read by the legacy import), so a token equal to it is refused in both cases; the message names
  // the variable that matched.
  if (token === trimmed(env.APP_SECRET)) return "must differ from APP_SECRET";
  if (token === trimmed(env.BETTER_AUTH_SECRET))
    return "must differ from BETTER_AUTH_SECRET";
  return null;
}

/**
 * The token as it is used, or undefined when the API is off: not set, or set to something
 * {@link operatorTokenProblem} refuses.
 */
export function configuredOperatorToken(env: Env): string | undefined {
  const token = trimmed(env.OPERATOR_API_TOKEN);
  return token === undefined || operatorTokenProblem(env) !== null
    ? undefined
    : token;
}

/**
 * Constant time for any lengths and characters (both sides are hashed first, then compared), and false while no
 * token is configured.
 */
export function operatorTokensMatch(
  configured: string | undefined,
  provided: string,
): boolean {
  return tokensMatch(configured, provided);
}
