// SPDX-License-Identifier: LicenseRef-Proprietary

// The one rule for the GitHub addresses the app talks to. They default to the real GitHub. The sign
// in sends the client secret and the authorization code to its address, the GitHub App sends its
// JWT and tokens to its address, so any other address is only accepted together with
// ALLOW_TEST_GITHUB_ENDPOINTS=true, which only the test stack sets (it points the app at the fake
// GitHub, fakes/github). Naming the real GitHub explicitly is fine without the flag.
// Used by the sign in settings (src/auth/config.ts) and the GitHub App settings
// (src/integrations/providers/github-app/config.ts), so both read the flag and the addresses alike.

export const ALLOW_TEST_GITHUB_ENDPOINTS_FLAG = "ALLOW_TEST_GITHUB_ENDPOINTS";

type Env = Readonly<Record<string, string | undefined>>;

/** True exactly when the flag is `true` (surrounding whitespace ignored; `TRUE` or `1` are not). */
export function testGithubEndpointsAllowed(env: Env): boolean {
  return env[ALLOW_TEST_GITHUB_ENDPOINTS_FLAG]?.trim() === "true";
}

export type GithubEndpoint =
  | { ok: true; url: string }
  /** `not_allowed`: another address without the flag. `invalid`: not an http or https URL. */
  | { ok: false; problem: "not_allowed" | "invalid" };

/**
 * The address to use for a GitHub endpoint. `raw` is the value of the variable (an unset, empty or
 * blank value means `fallback`, the real GitHub). The result has no trailing slash.
 */
export function resolveGithubEndpoint(
  raw: string | undefined,
  fallback: string,
  allowTestEndpoints: boolean,
): GithubEndpoint {
  const text = raw?.trim();
  if (!text) return { ok: true, url: fallback };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, problem: "invalid" };
  const normalized = url.origin + url.pathname.replace(/\/+$/, "");
  if (normalized === fallback) return { ok: true, url: fallback };
  return allowTestEndpoints
    ? { ok: true, url: normalized }
    : { ok: false, problem: "not_allowed" };
}
