// SPDX-License-Identifier: Apache-2.0

// The one rule for the address the app sends its Stripe API key to (ADR 0006; #505). It is Stripe's own address: no setting of an
// operator, no variable they need. The test stack points the app at the fake Stripe (`fakes/stripe`) through STRIPE_API_BASE_URL, and
// only together with ALLOW_TEST_STRIPE_ENDPOINTS=true, which only the test stack sets (the pattern of ALLOW_TEST_GITHUB_ENDPOINTS,
// `github-endpoints.ts`). The key is a bearer token, so the rule is stricter than GitHub's: even with the flag only plain http on a
// loopback address is accepted (the fake never listens anywhere else), and anything else, or any address without the flag, is
// ignored in favour of Stripe's own address. Billing code asks `stripeApiBaseUrl()` and never reads the environment itself
// (`billing/no-environment-variable.test.ts`).
import { isIP } from "node:net";

export const STRIPE_API_BASE_URL_VARIABLE = "STRIPE_API_BASE_URL";
export const ALLOW_TEST_STRIPE_ENDPOINTS_FLAG = "ALLOW_TEST_STRIPE_ENDPOINTS";

/** Stripe's one API address (the same for test and live mode). */
export const STRIPE_API_ADDRESS = "https://api.stripe.com";

type Env = Readonly<Record<string, string | undefined>>;

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return bare.startsWith("127.");
  return isIP(bare) === 6 && bare === "::1";
}

/** The address to use, from an environment: Stripe's own unless the test stack names a loopback fake and says it may. */
export function stripeApiBaseUrlOf(env: Env): string {
  if (env[ALLOW_TEST_STRIPE_ENDPOINTS_FLAG]?.trim() !== "true")
    return STRIPE_API_ADDRESS;
  const text = env.STRIPE_API_BASE_URL?.trim();
  if (!text) return STRIPE_API_ADDRESS;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return STRIPE_API_ADDRESS;
  }
  const plain =
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "";
  if (!plain || !isLoopbackHost(url.hostname)) return STRIPE_API_ADDRESS;
  return url.origin;
}

/**
 * The one origin, besides Stripe's own hosts, whose invoice links the app shows (#659): the fake Stripe's, and only where the
 * address above is the fake's. Undefined in production, where the address is always Stripe's own.
 */
export function stripeLinkOriginOf(env: Env): string | undefined {
  const address = stripeApiBaseUrlOf(env);
  return address === STRIPE_API_ADDRESS ? undefined : new URL(address).origin;
}

/** The address of the running server: the process environment, read when it is asked for. */
export function stripeApiBaseUrl(): string {
  return stripeApiBaseUrlOf(process.env);
}

/** The origin of the invoice links of the running server (`stripeLinkOriginOf` on the process environment). */
export function stripeLinkOrigin(): string | undefined {
  return stripeLinkOriginOf(process.env);
}
