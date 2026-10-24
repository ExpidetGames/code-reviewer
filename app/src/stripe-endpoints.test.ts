// SPDX-License-Identifier: LicenseRef-Proprietary

// #505: the one rule for the address the app sends its Stripe API key to. It is Stripe's own address. The test stack
// (`ALLOW_TEST_STRIPE_ENDPOINTS=true`) may point the app at the fake Stripe (`fakes/stripe`), and only at a loopback address over plain http:
// the key is a bearer token, so no other address is ever accepted, flag or not.
import { describe, expect, it } from "vitest";
import { STRIPE_API_BASE_URL } from "./billing/stripe-client.ts";
import {
  ALLOW_TEST_STRIPE_ENDPOINTS_FLAG,
  STRIPE_API_ADDRESS,
  STRIPE_API_BASE_URL_VARIABLE,
  stripeApiBaseUrlOf,
  stripeLinkOriginOf,
} from "./stripe-endpoints.ts";

const STRIPE = "https://api.stripe.com";

// #505-T03
it("names the address the client of the billing module names", () => {
  expect(STRIPE_API_ADDRESS).toBe(STRIPE_API_BASE_URL);
});
const allow = { [ALLOW_TEST_STRIPE_ENDPOINTS_FLAG]: "true" };

describe("the address of the Stripe API", () => {
  // #505-T03
  it("is Stripe's own address when nothing is set", () => {
    expect(stripeApiBaseUrlOf({})).toBe(STRIPE);
    expect(
      stripeApiBaseUrlOf({ ...allow, [STRIPE_API_BASE_URL_VARIABLE]: "  " }),
    ).toBe(STRIPE);
  });

  // #505-T03
  it("is the fake's loopback address for the test stack, with the flag", () => {
    expect(
      stripeApiBaseUrlOf({
        ...allow,
        [STRIPE_API_BASE_URL_VARIABLE]: "http://127.0.0.1:3426/",
      }),
    ).toBe("http://127.0.0.1:3426");
    expect(
      stripeApiBaseUrlOf({
        ...allow,
        [STRIPE_API_BASE_URL_VARIABLE]: "http://localhost:3426",
      }),
    ).toBe("http://localhost:3426");
  });

  // #505-T03
  it("ignores the address without the flag, so a stray variable never moves the key", () => {
    for (const flag of [undefined, "", "1", "TRUE", "false"])
      expect(
        stripeApiBaseUrlOf({
          [STRIPE_API_BASE_URL_VARIABLE]: "http://127.0.0.1:3426",
          ...(flag === undefined
            ? {}
            : { [ALLOW_TEST_STRIPE_ENDPOINTS_FLAG]: flag }),
        }),
      ).toBe(STRIPE);
  });

  // #505-T03
  it.each([
    "https://stripe.example.test",
    "http://example.com:3426",
    "http://10.0.0.5:3426",
    "https://127.0.0.1:3426",
    "http://user:pass@127.0.0.1:3426",
    "ftp://127.0.0.1",
    "not a url",
    "http://127.0.0.1:3426/v1",
  ])("never accepts %s, with the flag either", (address) => {
    expect(
      stripeApiBaseUrlOf({ ...allow, [STRIPE_API_BASE_URL_VARIABLE]: address }),
    ).toBe(STRIPE);
  });
});

describe("the origin of the invoice links the app shows", () => {
  // #659-T05
  it("is the fake's origin only for the test stack with the flag and a loopback address", () => {
    expect(
      stripeLinkOriginOf({
        ...allow,
        [STRIPE_API_BASE_URL_VARIABLE]: "http://127.0.0.1:3426/",
      }),
    ).toBe("http://127.0.0.1:3426");
  });

  // #659-T05
  it("is none in production, whatever else is set", () => {
    expect(stripeLinkOriginOf({})).toBeUndefined();
    for (const env of [
      { [STRIPE_API_BASE_URL_VARIABLE]: "http://127.0.0.1:3426" },
      { ...allow, [STRIPE_API_BASE_URL_VARIABLE]: "https://evil.example" },
      { ...allow, [STRIPE_API_BASE_URL_VARIABLE]: "http://evil.example:80" },
      { ...allow },
    ])
      expect(stripeLinkOriginOf(env)).toBeUndefined();
  });
});
