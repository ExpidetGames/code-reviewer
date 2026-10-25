// SPDX-License-Identifier: LicenseRef-Proprietary

// The proxy's step for a visitor who comes from code-review.com: the identifiers in the address of `/sign-up` and `/login`
// go into one short-lived cookie and out of the address; nothing else about the request changes.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { captureLandingIdentity } from "./capture.ts";
import { LANDING_IDENTITY_COOKIE } from "./identity.ts";

const BASE = "http://localhost:3000";
const DID = "0192f5f0-7c3e-7a52-9d1b-3f6a2c4e8b10";
const SID = "0192f5f0-7c3e-7a52-9d1b-aaaaaaaaaaaa";

function get(path: string, method = "GET"): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method });
}

describe("the landing identity in the address of the sign-up and the login", () => {
  // #692-T02
  it.each(["/sign-up", "/login"])(
    "goes into a cookie and out of the address of %s",
    (path) => {
      const response = captureLandingIdentity(
        get(`${path}?ph_did=${DID}&ph_sid=${SID}`),
        { secure: () => false },
      );

      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(`${BASE}${path}`);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(response?.cookies.get(LANDING_IDENTITY_COOKIE)).toMatchObject({
        value: `${DID}~${SID}`,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 3600,
      });
    },
  );

  // #692-T02
  it("takes the decoration time out of the address too, and stores nothing of it", () => {
    const withBoth = captureLandingIdentity(
      get(`/sign-up?ph_did=${DID}&ph_ts=1761400000000`),
      { secure: () => false },
    );
    const alone = captureLandingIdentity(get("/login?ph_ts=1761400000000"), {
      secure: () => false,
    });

    expect(withBoth?.headers.get("location")).toBe(`${BASE}/sign-up`);
    expect(withBoth?.cookies.get(LANDING_IDENTITY_COOKIE)?.value).toBe(
      `${DID}~`,
    );
    expect(alone?.headers.get("location")).toBe(`${BASE}/login`);
    expect(alone?.cookies.get(LANDING_IDENTITY_COOKIE)).toBeUndefined();
  });

  // #692-T02
  it("marks the cookie Secure exactly when the app is served over https", () => {
    const secure = captureLandingIdentity(get(`/sign-up?ph_did=${DID}`), {
      secure: () => true,
    });
    const plain = captureLandingIdentity(get(`/sign-up?ph_did=${DID}`), {
      secure: () => false,
    });

    expect(secure?.cookies.get(LANDING_IDENTITY_COOKIE)?.secure).toBe(true);
    expect(plain?.cookies.get(LANDING_IDENTITY_COOKIE)?.secure).toBeFalsy();
  });

  // #692-T02
  it("keeps the other parameters of the address, such as an invitation", () => {
    const token = "B".repeat(43);

    const response = captureLandingIdentity(
      get(`/sign-up?invitation=${token}&ph_did=${DID}`),
      { secure: () => false },
    );

    expect(response?.headers.get("location")).toBe(
      `${BASE}/sign-up?invitation=${token}`,
    );
    expect(response?.cookies.get(LANDING_IDENTITY_COOKIE)?.value).toBe(
      `${DID}~`,
    );
  });

  // #692-T06
  it("sets no cookie for an invalid value, and still takes the parameters out of the address", () => {
    const response = captureLandingIdentity(
      get(`/login?ph_did=${"x".repeat(201)}&ph_sid=a%20b`),
      { secure: () => false },
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(`${BASE}/login`);
    expect(response?.cookies.get(LANDING_IDENTITY_COOKIE)).toBeUndefined();
  });

  // #692-T02
  it.each([
    ["a request without the parameters", "/sign-up", "GET"],
    ["a page that is not the sign-up or the login", `/?ph_did=${DID}`, "GET"],
    ["a sub path", `/login/extra?ph_did=${DID}`, "GET"],
    ["a POST", `/sign-up?ph_did=${DID}`, "POST"],
  ])("leaves %s alone", (_label, path, method) => {
    expect(
      captureLandingIdentity(get(path, method), { secure: () => false }),
    ).toBeNull();
  });
});
