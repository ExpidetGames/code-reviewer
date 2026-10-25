// SPDX-License-Identifier: LicenseRef-Proprietary

// The two identifiers a visitor of code-review.com brings along are opaque text from outside: only a plain, short
// shape is accepted, anything else is ignored without a word.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { captureLandingIdentity } from "./capture.ts";
import {
  LANDING_IDENTITY_COOKIE,
  LANDING_IDENTITY_HOST_COOKIE,
  LANDING_IDENTITY_MAX_AGE_SECONDS,
  carriesLandingIdentityCookie,
  clearedLandingIdentityCookies,
  encodeLandingIdentity,
  landingIdentityCookieName,
  landingIdentityFromCookieHeader,
  landingIdentityFromSearchParams,
  validLandingId,
} from "./identity.ts";

const UUID_V7 = "0192f5f0-7c3e-7a52-9d1b-3f6a2c4e8b10";
const LEGACY_ID =
  "18c5a3f2e1b4d6-0a1b2c3d4e5f6a-26001a51-1fa400-18c5a3f2e1c5d7";

describe("a landing identifier", () => {
  // #692-T01
  it.each([UUID_V7, LEGACY_ID, "a", "user_1:abc.def-GHI", "x".repeat(200)])(
    "is accepted when it is plain and short: %s",
    (value) => {
      expect(validLandingId(value)).toBe(value);
    },
  );

  // #692-T01
  it.each([
    ["empty", ""],
    ["too long", "x".repeat(201)],
    ["with a space", "abc def"],
    ["with a slash", "abc/def"],
    ["with a quote", 'abc"def'],
    ["with an at sign", "a@b.example"],
    ["with a semicolon", "a;b"],
    ["with a tilde, the separator of the cookie", "a~b"],
    ["with a percent sign", "a%20b"],
    ["with a line break", "abc\ndef"],
    ["with a non-ASCII letter", "äbc"],
    ["a number", 5],
    ["an array", ["a"]],
    ["null", null],
    ["undefined", undefined],
  ])("is refused when it is %s", (_label, value) => {
    expect(validLandingId(value)).toBeNull();
  });
});

describe("the identity read from the address", () => {
  // #692-T01
  it("holds both identifiers when both are valid", () => {
    const params = new URLSearchParams({ ph_did: UUID_V7, ph_sid: LEGACY_ID });
    expect(landingIdentityFromSearchParams(params)).toEqual({
      distinctId: UUID_V7,
      sessionId: LEGACY_ID,
    });
  });

  // #692-T01
  it("keeps the valid identifier when the other one is invalid", () => {
    const params = new URLSearchParams({
      ph_did: UUID_V7,
      ph_sid: "bad value",
    });
    expect(landingIdentityFromSearchParams(params)).toEqual({
      distinctId: UUID_V7,
      sessionId: null,
    });
  });

  // #692-T01
  it("is nothing when neither parameter is there or valid", () => {
    expect(landingIdentityFromSearchParams(new URLSearchParams())).toBeNull();
    expect(
      landingIdentityFromSearchParams(
        new URLSearchParams({ ph_did: "x".repeat(201), ph_sid: "a b" }),
      ),
    ).toBeNull();
  });

  // #692-T01
  it("reads the first value when a parameter is repeated", () => {
    const params = new URLSearchParams(`ph_did=${UUID_V7}&ph_did=other`);
    expect(landingIdentityFromSearchParams(params)?.distinctId).toBe(UUID_V7);
  });
});

describe("the cookie that carries the identity across the sign in", () => {
  it("lives for one hour", () => {
    expect(LANDING_IDENTITY_MAX_AGE_SECONDS).toBe(3600);
  });

  // #692-T02
  it("round-trips both identifiers, or only one of them", () => {
    for (const identity of [
      { distinctId: UUID_V7, sessionId: LEGACY_ID },
      { distinctId: UUID_V7, sessionId: null },
      { distinctId: null, sessionId: LEGACY_ID },
    ]) {
      const header = `a=b; ${LANDING_IDENTITY_COOKIE}=${encodeLandingIdentity(identity)}; c=d`;
      expect(landingIdentityFromCookieHeader(header)).toEqual(identity);
    }
  });

  // #692-T06
  it.each([
    ["no header", null],
    ["another cookie", "a=b"],
    ["an empty value", `${LANDING_IDENTITY_COOKIE}=`],
    ["a value without the separator", `${LANDING_IDENTITY_COOKIE}=abc`],
    ["only the separator", `${LANDING_IDENTITY_COOKIE}=~`],
    ["an invalid identifier", `${LANDING_IDENTITY_COOKIE}=a%20b~c`],
    ["too many parts", `${LANDING_IDENTITY_COOKIE}=a~b~c`],
    [
      "an over-long identifier",
      `${LANDING_IDENTITY_COOKIE}=${"x".repeat(201)}~`,
    ],
  ])("is nothing for %s", (_label, header) => {
    expect(landingIdentityFromCookieHeader(header)).toBeNull();
  });
});

describe("the cookie as the browser sends it back", () => {
  /** What the browser sends back for the `Set-Cookie` lines of a response: the name and value of each, as they are. */
  function cookieHeaderOf(response: Response): string {
    return response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
  }

  // #692-T02
  it.each([
    ["with a colon in both", "user_1:abc", "sess:xyz"],
    ["with a colon in one", "a:b", "plain"],
    ["a UUID and a legacy id", UUID_V7, LEGACY_ID],
  ])(
    "returns the identifiers the proxy set through Next's cookie API, %s",
    (_label, did, sid) => {
      for (const secure of [false, true]) {
        const response = captureLandingIdentity(
          new NextRequest(
            `http://localhost:3000/sign-up?ph_did=${encodeURIComponent(did)}&ph_sid=${encodeURIComponent(sid)}`,
          ),
          { secure: () => secure },
        );

        expect(response).not.toBeNull();
        expect(
          landingIdentityFromCookieHeader(cookieHeaderOf(response as Response)),
        ).toEqual({ distinctId: did, sessionId: sid });
      }
    },
  );

  // #692-T02
  it("percent-decodes the value before it checks it", () => {
    expect(
      landingIdentityFromCookieHeader(`${LANDING_IDENTITY_COOKIE}=a%3Ab~x%3Ay`),
    ).toEqual({ distinctId: "a:b", sessionId: "x:y" });
  });

  // #692-T06
  it.each([
    ["a malformed escape", "a%E0%A4%A~b"],
    ["an escape of a character that is not allowed", "a%2Fb~c"],
    ["an escaped separator that makes three parts", "a%7Eb~c"],
    ["an escaped line break", "a%0Ab~c"],
  ])("is nothing for %s", (_label, value) => {
    expect(
      landingIdentityFromCookieHeader(`${LANDING_IDENTITY_COOKIE}=${value}`),
    ).toBeNull();
  });

  // #692-T02
  it("is named with the __Host- prefix exactly when it is Secure", () => {
    expect(landingIdentityCookieName(true)).toBe("__Host-cr-landing");
    expect(landingIdentityCookieName(false)).toBe("cr-landing");
  });

  // #692-T02
  it("is read under both names, the prefixed one first", () => {
    expect(
      landingIdentityFromCookieHeader(`${LANDING_IDENTITY_HOST_COOKIE}=a~b`),
    ).toEqual({ distinctId: "a", sessionId: "b" });
    expect(
      landingIdentityFromCookieHeader(
        `${LANDING_IDENTITY_COOKIE}=plain~plain; ${LANDING_IDENTITY_HOST_COOKIE}=host~host`,
      ),
    ).toEqual({ distinctId: "host", sessionId: "host" });
  });

  // #692-T03
  it("is removed under the name the request carried, the prefixed one with Secure", () => {
    expect(
      clearedLandingIdentityCookies(`${LANDING_IDENTITY_HOST_COOKIE}=a~b`),
    ).toEqual([
      "__Host-cr-landing=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    ]);
    expect(
      clearedLandingIdentityCookies(`x=y; ${LANDING_IDENTITY_COOKIE}=a~b`),
    ).toEqual(["cr-landing=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"]);
    expect(clearedLandingIdentityCookies("x=y")).toEqual([]);
    expect(carriesLandingIdentityCookie(`${LANDING_IDENTITY_COOKIE}=bad`)).toBe(
      true,
    );
    expect(carriesLandingIdentityCookie("x=y")).toBe(false);
  });
});
