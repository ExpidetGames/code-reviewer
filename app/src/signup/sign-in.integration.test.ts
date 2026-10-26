// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the email and password sign in of an account that has to verify its address: through the real
// HTTP route and through the login form's function, with the real Better Auth, the real sign-up and a
// real Postgres database. An unverified address does not sign in while the instance can send mail (no session,
// no cookie), but only after the password was right, the instance admin signs in all the same, and a
// verified account, or any account on an instance without mail, signs in as before.
import { describe, expect, it } from "vitest";
import { handleAuthRequest } from "../auth/http.ts";
import { signInWithPasswordChecked } from "../auth/password-sign-in.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createSignInLimiter } from "../auth/sign-in-limit.ts";
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
    await harness.verify({
      token: harness.mail.lastToken(ADDRESS),
      password: SIGNUP_TEST_PASSWORD,
    });

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

describe("the answer to a sign in with a wrong password", () => {
  // #99-SR-14
  it("is the same bytes, with the same content type and headers, for an unknown, refused, verified and waiting address", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "emails", entries: [ADDRESS, "verified@example.com"] },
    });
    await signedUp(harness);
    await harness.signUp({
      email: "verified@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();
    await harness.verify({
      token: harness.mail.lastToken("verified@example.com"),
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.signUp({
      email: "refused@evil.example",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    const answers: Array<{
      text: string;
      type: string | null;
      headers: string[];
      status: number;
    }> = [];
    for (const email of [
      "nobody@example.com",
      "refused@evil.example",
      "verified@example.com",
      ADDRESS,
    ]) {
      const response = await signIn(harness, email, "not-the-password-1234");
      answers.push({
        status: response.status,
        // The text as it came, not parsed: the order of the keys is part of the answer.
        text: await response.text(),
        type: response.headers.get("content-type"),
        headers: [...response.headers.keys()].sort(),
      });
    }

    expect(answers[0]?.status).toBe(401);
    expect(answers[0]?.text).toBe(
      '{"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}',
    );
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
  });
});

describe("the work of a sign in with a wrong password", () => {
  // Counts every hash and every check of a password that Better Auth's context is asked for, for
  // whichever code asks (its sign in and our hook in front of it use the same context).
  async function countWork(harness: SignUpHarness) {
    const context = await harness.auth.$context;
    const count = { hash: 0, verify: 0 };
    const { hash, verify } = context.password;
    context.password.hash = (password) => {
      count.hash += 1;
      return hash(password);
    };
    context.password.verify = (input) => {
      count.verify += 1;
      return verify(input);
    };
    return count;
  }

  // #99-SR-14
  it("hashes exactly once whether the address is unknown, refused by the rule, verified or waiting for verification", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "emails", entries: [ADDRESS, "verified@example.com"] },
    });
    await signedUp(harness);
    await harness.signUp({
      email: "verified@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();
    await harness.verify({
      token: harness.mail.lastToken("verified@example.com"),
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.signUp({
      email: "refused@evil.example",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();
    const work = await countWork(harness);

    const perClass: Record<string, number> = {};
    for (const [name, email] of [
      ["unknown", "nobody@example.com"],
      ["refused by the rule", "refused@evil.example"],
      ["verified", "verified@example.com"],
      ["waiting for verification", ADDRESS],
    ] as const) {
      work.hash = 0;
      work.verify = 0;
      const response = await signIn(harness, email, "not-the-password-1234");
      expect(response.status, name).toBe(401);
      perClass[name] = work.hash + work.verify;
    }

    expect(perClass).toEqual({
      unknown: 1,
      "refused by the rule": 1,
      verified: 1,
      "waiting for verification": 1,
    });
  });

  // #99-SR-14
  it("checks the right password of an account that waits for verification once, too", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    const work = await countWork(harness);

    const response = await signIn(harness, ADDRESS, SIGNUP_TEST_PASSWORD);

    expect(response.status).toBe(403);
    expect(work.hash + work.verify).toBe(1);
  });
});

describe("the sign in limit and an address that is not verified", () => {
  function limiterOf(harness: SignUpHarness) {
    return createSignInLimiter(createRateLimitsRepository(harness.db));
  }

  // #99-SR-19
  it("does not count the right password of an unverified account as a failed attempt (HTTP route)", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    const limiter = limiterOf(harness);
    const attempt = (password: string) =>
      handleAuthRequest(
        harness.auth,
        new Request(`${SIGNUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: SIGNUP_TEST_BASE_URL,
          },
          body: JSON.stringify({ email: ADDRESS, password }),
        }),
        limiter,
      );
    for (let i = 0; i < 4; i += 1)
      expect((await attempt("not-the-password-1234")).status).toBe(401);

    const notVerified = await attempt(SIGNUP_TEST_PASSWORD);
    const after = [];
    for (let i = 0; i < 5; i += 1)
      after.push((await attempt("not-the-password-1234")).status);

    expect(notVerified.status).toBe(403);
    // Five more wrong attempts fit: the counter started again at the right password.
    expect(after).toEqual([401, 401, 401, 401, 401]);
  });

  // #99-SR-19
  it("does not count it either through the login form", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    const limiter = limiterOf(harness);
    const attempt = (password: string) =>
      signInWithPasswordChecked(
        {
          limiter,
          signIn: (email, pw) =>
            harness.auth.api.signInEmail({ body: { email, password: pw } }),
        },
        ADDRESS,
        password,
      );
    for (let i = 0; i < 4; i += 1) await attempt("not-the-password-1234");

    const notVerified = await attempt(SIGNUP_TEST_PASSWORD);
    const after = [];
    for (let i = 0; i < 5; i += 1)
      after.push((await attempt("not-the-password-1234")).kind);

    expect(notVerified).toEqual({ kind: "email_not_verified" });
    expect(after).toEqual(Array(5).fill("invalid_credentials"));
  });
});
