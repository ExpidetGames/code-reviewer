// SPDX-License-Identifier: LicenseRef-Proprietary

// The two identifiers a visitor of code-review.com brings along are opaque text from outside: only a plain, short
// shape is accepted, anything else is ignored without a word.
import { describe, expect, it } from "vitest";
import {
  LANDING_IDENTITY_COOKIE,
  LANDING_IDENTITY_MAX_AGE_SECONDS,
  encodeLandingIdentity,
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
