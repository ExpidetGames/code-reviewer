// Pins down the sign in with email and password against the real Better Auth instance and a real
// database: the instance admin the setup creates signs in, is recognized as the instance admin, needs
// no GitHub identity and no entry on the GitHub allow list, a wrong password and an unknown email get
// the same refusal, and the password rule holds on every path that sets a password.
import { describe, expect, it } from "vitest";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_CODE,
  WIZARD_BODY,
} from "../test-support/setup-harness.ts";
import { cookieHeader, remember } from "../test-support/auth-harness.ts";
import { handleAuthRequest } from "./http.ts";
import { lookupSession } from "./session-user.ts";

async function setUpInstance() {
  const harness = await createSetupHarness();
  await harness.start();
  const cookies = new Map<string, string>();
  await harness.submitCode(SETUP_TEST_CODE, cookies);
  await harness.complete(cookies, WIZARD_BODY);
  return { harness, cookies };
}

function signInRequest(email: string, password: string) {
  return new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: SETUP_TEST_BASE_URL,
    },
    body: JSON.stringify({ email, password }),
  });
}

describe("signing in with email and password", () => {
  it("signs the instance admin in and recognizes them as the instance admin without a GitHub identity", async () => {
    const { harness } = await setUpInstance();
    const response = await handleAuthRequest(
      harness.auth,
      signInRequest(SETUP_TEST_ADMIN.email, SETUP_TEST_ADMIN.password),
    );
    const cookies = new Map<string, string>();
    remember(cookies, response);

    // A policy that refuses everybody: an account with a password does not go through it.
    const lookup = await lookupSession(
      harness.auth,
      new Headers({ cookie: cookieHeader(cookies) }),
      () => Promise.resolve({ allowed: false, reason: "not_allowed" }),
    );

    expect(response.status).toBe(200);
    expect(lookup).toMatchObject({
      kind: "user",
      user: {
        email: SETUP_TEST_ADMIN.email,
        isInstanceAdmin: true,
        githubLogin: null,
        githubId: null,
      },
    });
  });

  it("treats the email address case-insensitively", async () => {
    const { harness } = await setUpInstance();

    const response = await handleAuthRequest(
      harness.auth,
      signInRequest(
        SETUP_TEST_ADMIN.email.toUpperCase(),
        SETUP_TEST_ADMIN.password,
      ),
    );

    expect(response.status).toBe(200);
  });

  it("gives a wrong password and an unknown email the same refusal and no session", async () => {
    const { harness } = await setUpInstance();

    const wrongPassword = await handleAuthRequest(
      harness.auth,
      signInRequest(SETUP_TEST_ADMIN.email, "a-wrong-password-12"),
    );
    const unknown = await handleAuthRequest(
      harness.auth,
      signInRequest("nobody@example.com", SETUP_TEST_ADMIN.password),
    );

    expect(wrongPassword.status).toBe(unknown.status);
    expect(await wrongPassword.json()).toEqual(await unknown.json());
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  it("does not offer the sign-up or the password endpoints over HTTP", async () => {
    const { harness } = await setUpInstance();

    for (const path of [
      "/api/auth/sign-up/email",
      "/api/auth/change-password",
      "/api/auth/reset-password",
      "/api/auth/request-password-reset",
    ]) {
      const response = await handleAuthRequest(
        harness.auth,
        new Request(`${SETUP_TEST_BASE_URL}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: SETUP_TEST_BASE_URL,
          },
          body: JSON.stringify({
            email: "a@example.com",
            password: "x7Kq-m2Vd9Lw",
          }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  // #97-SU-10
  it("applies the password rule to a password that is set through Better Auth", async () => {
    const { harness } = await setUpInstance();
    const response = await handleAuthRequest(
      harness.auth,
      signInRequest(SETUP_TEST_ADMIN.email, SETUP_TEST_ADMIN.password),
    );
    const headers = new Headers({
      cookie: cookieHeader(
        (() => {
          const jar = new Map<string, string>();
          remember(jar, response);
          return jar;
        })(),
      ),
    });

    const refusal = await harness.auth.api
      .changePassword({
        body: {
          currentPassword: SETUP_TEST_ADMIN.password,
          newPassword: "password1234",
        },
        headers,
      })
      .then(
        () => null,
        (error: unknown) => error as { body?: { code?: string } },
      );

    expect(refusal?.body?.code).toBe("password_too_common");
  });
});
