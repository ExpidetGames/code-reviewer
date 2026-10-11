// SPDX-License-Identifier: Apache-2.0

// Pins down the email and password sign in of an account that has to verify its address: through the real
// HTTP route and through the login form's function, with the real Better Auth, the real sign-up and a
// real SQLite file. An unverified address does not sign in while the instance can send mail (no session,
// no cookie), but only after the password was right, the instance admin signs in all the same, and a
// verified account, or any account on an instance without mail, signs in as before.
import { describe, expect, it } from "vitest";
import { handleAuthRequest } from "../auth/http.ts";
import { signInWithPasswordChecked } from "../auth/password-sign-in.ts";
import { unlimitedSignIns } from "../test-support/sign-in-limiter.ts";
import {
  createSignUpHarness,
  SIGNUP_TEST_BASE_URL,
  SIGNUP_TEST_PASSWORD,
  type SignUpHarness,
} from "../test-support/signup-harness.ts";

const ADDRESS = "newcomer@example.com";

function signIn(harness: SignUpHarness, email: string, password: string) {
  return handleAuthRequest(
    harness.auth,
    new Request(`${SIGNUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SIGNUP_TEST_BASE_URL,
      },
      body: JSON.stringify({ email, password }),
    }),
    unlimitedSignIns,
  );
}

async function signedUp(harness: SignUpHarness) {
  await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
  await harness.flush();
}

describe("signing in with an address that is not verified", () => {
  // #99-SR-10
  it("is refused with 403 EMAIL_NOT_VERIFIED, with no session and no cookie, after the right password", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "emails", entries: [ADDRESS] },
    });
    await signedUp(harness);
    const before = await harness.counts();

    const response = await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await harness.counts()).sessions).toBe(before.sessions);
  });

  // #99-SR-11
  it("works after the link was opened", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    await harness.verify({ token: harness.mail.lastToken(ADDRESS) });

    const response = await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  // #99-SR-14
  it("answers a wrong password and an unknown address alike: nothing says that the account waits for verification", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);

    const wrongPassword = await signIn(
      harness,
      ADDRESS,
      "not-the-password-1234",
    );
    const unknown = await signIn(
      harness,
      "nobody@example.com",
      "not-the-password-1234",
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(wrongPassword.status);
    expect(await unknown.json()).toEqual(await wrongPassword.json());
  });

  // #99-SR-24
  it("still signs the instance admin in", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await signIn(
      harness,
      harness.admin.email,
      harness.admin.password,
    );

    expect(response.status).toBe(200);
  });

  // #99-SR-08
  it("signs in when the instance has no mail server", async () => {
    const harness = await createSignUpHarness({ mail: false });
    await signedUp(harness);

    const response = await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD);

    expect(response.status).toBe(200);
  });

  // #99-SR-24
  it("is refused as soon as a mail server exists, also for an account made before", async () => {
    const harness = await createSignUpHarness({ mail: false });
    await signedUp(harness);
    expect((await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD)).status).toBe(
      200,
    );

    harness.mail.configured = true;

    expect((await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD)).status).toBe(
      403,
    );
  });

  // #99-SR-10
  it("is reported to the login form as email_not_verified", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);

    const outcome = await signInWithPasswordChecked(
      {
        limiter: unlimitedSignIns,
        signIn: (email, password) =>
          harness.auth.api.signInEmail({ body: { email, password } }),
      },
      ADDRESS,
      SIGNUP_TEST_PASSWORD,
    );

    expect(outcome).toEqual({ kind: "email_not_verified" });
  });
});
