// SPDX-License-Identifier: Apache-2.0

// Pins down the sign-up with email and password through the real route handler, the real Better Auth
// password hash, the real counters and a real SQLite file: who may sign up, what is created, what is sent,
// and that no answer says whether an address has an account or is allowed.
import { describe, expect, it, vi } from "vitest";
import {
  createSignUpHarness,
  SIGNUP_TEST_PASSWORD,
} from "../test-support/signup-harness.ts";
import { PASSWORD_MAX_LENGTH } from "../auth/password-policy.ts";

const ADDRESS = "newcomer@example.com";

async function readAnswer(response: Response) {
  return {
    status: response.status,
    body: await response.json(),
    retryAfter: response.headers.get("retry-after"),
  };
}

describe("signing up under the rule everyone", () => {
  // #99-SR-08
  it("creates a usable account at once when the instance has no mail server, with the email marked unverified", async () => {
    const harness = await createSignUpHarness({ mail: false });

    const response = await harness.signUp({
      email: ADDRESS,
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(await readAnswer(response)).toMatchObject({
      status: 200,
      body: { ok: true, next: "sign_in" },
    });
    expect(harness.mail.outbox).toEqual([]);
    const user = await harness.user(ADDRESS);
    expect(user).toMatchObject({
      email_verified: 0,
      is_instance_admin: 0,
      github_login: null,
      imported_at: null,
    });
    // The password is stored in Better Auth's format: the sign in with it works.
    const signIn = await harness.auth.api.signInEmail({
      body: { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
    });
    expect(signIn.user.id).toBe(user?.id);
  });

  // #99-SR-23
  it("creates an unverified account and sends one verification message when the instance has a mail server", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp({
      email: ADDRESS,
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(await readAnswer(response)).toMatchObject({
      status: 200,
      body: { ok: true, next: "verify_email" },
    });
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
    expect(harness.mail.outbox).toHaveLength(1);
    expect(harness.mail.outbox[0]?.to).toBe(ADDRESS);
    expect(harness.mail.lastLink(ADDRESS)).toMatch(
      /^http:\/\/localhost:3000\/verify-email\?token=[A-Za-z0-9_-]{43}$/,
    );
  });

  it("stores the address in its canonical form and starts a plain account without a workspace", async () => {
    const harness = await createSignUpHarness({ mail: true });

    await harness.signUp({
      email: "  New.Comer@Example.COM ",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    const user = await harness.user("new.comer@example.com");
    expect(user).toBeDefined();
    const memberships = await harness.db
      .selectFrom("workspace_members")
      .select("user_id")
      .where("user_id", "=", user?.id ?? "")
      .execute();
    expect(memberships).toEqual([]);
    expect(harness.mail.to("new.comer@example.com")).toHaveLength(1);
  });

  // #99-SR-14
  it("answers a sign-up for an address with a verified account exactly like a new one, changes nothing and sends nothing", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const fresh = await readAnswer(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );
    await harness.flush();
    await harness.verify({
      token: harness.mail.lastToken(ADDRESS),
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.db
      .updateTable("users")
      .set({ email_verified: 1 })
      .where("email", "=", harness.admin.email)
      .execute();
    const before = await harness.counts();
    const mails = harness.mail.outbox.length;

    const again = await readAnswer(
      await harness.signUp({
        email: ADDRESS,
        password: "a-completely-different-pw-77",
      }),
    );
    const adminAgain = await readAnswer(
      await harness.signUp({
        email: harness.admin.email,
        password: "a-completely-different-pw-77",
      }),
    );
    await harness.flush();

    expect(again).toEqual(fresh);
    expect(adminAgain).toEqual(fresh);
    expect(await harness.counts()).toEqual(before);
    expect(harness.mail.outbox).toHaveLength(mails);
    // The existing account keeps its password.
    await expect(
      harness.auth.api.signInEmail({
        body: { email: ADDRESS, password: "a-completely-different-pw-77" },
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  // #99-SR-14
  it("answers a sign-up for an address whose account waits for verification like a new one, without changing the account", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const fresh = await readAnswer(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );
    await harness.flush();
    const before = await harness.counts();
    const passwordBefore = await harness.db
      .selectFrom("accounts")
      .select("password")
      .where("user_id", "=", (await harness.user(ADDRESS))?.id ?? "")
      .executeTakeFirstOrThrow();

    const again = await readAnswer(
      await harness.signUp({
        email: ADDRESS,
        password: "a-completely-different-pw-77",
      }),
    );
    await harness.flush();

    expect(again).toEqual(fresh);
    expect(await harness.counts()).toEqual(before);
    // The account keeps its password; the second sign-up has a link of its own, like a new account.
    const passwordAfter = await harness.db
      .selectFrom("accounts")
      .select("password")
      .where("user_id", "=", (await harness.user(ADDRESS))?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(passwordAfter).toEqual(passwordBefore);
    expect(harness.mail.to(ADDRESS)).toHaveLength(2);
  });

  // #99-SR-14
  it("hashes the password whether the address is new, taken or refused by the rule, so the work does not show", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "domains", entries: ["example.com"] },
    });
    const attempt = (email: string) =>
      harness.signUp({ email, password: SIGNUP_TEST_PASSWORD });

    await attempt(ADDRESS);
    await attempt(ADDRESS);
    await attempt("stranger@evil.example");

    expect(harness.hashed.count).toBe(3);
  });

  // #99-SR-09
  it("answers a sign-up with the placeholder address of a GitHub user like any other and makes no account", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const fresh = await readAnswer(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );

    const reserved = await readAnswer(
      await harness.signUp({
        email: "583231@users.noreply.github.com",
        password: SIGNUP_TEST_PASSWORD,
      }),
    );
    await harness.flush();

    expect(reserved).toEqual(fresh);
    expect(
      await harness.user("583231@users.noreply.github.com"),
    ).toBeUndefined();
  });

  it("makes exactly one account when two sign-ups for one address arrive together", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const [first, second] = await Promise.all([
      harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
      harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    ]);
    await harness.flush();

    expect(await readAnswer(first)).toEqual(await readAnswer(second));
    const rows = await harness.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", ADDRESS)
      .execute();
    expect(rows).toHaveLength(1);
    // Each of the two sign-ups has a link of its own, bound to its password.
    expect(harness.mail.to(ADDRESS)).toHaveLength(2);
  });

  it("still creates the account when the mail cannot be sent, and logs only a code", async () => {
    const harness = await createSignUpHarness({ mail: true });
    harness.mail.failNext();

    const response = await harness.signUp({
      email: ADDRESS,
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(response.status).toBe(200);
    expect(await harness.user(ADDRESS)).toBeDefined();
    expect(harness.mail.outbox).toEqual([]);
    expect(harness.logs).toEqual([
      "[signup] VERIFICATION_MAIL_FAILED: a verification mail was not sent (mail_failed).",
    ]);
  });
});

describe("signing up under a rule that names addresses", () => {
  // #99-SR-10
  it("creates an unverified account for a listed address and sends one message", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "emails", entries: [ADDRESS] },
    });

    const response = await harness.signUp({
      email: ADDRESS,
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(response.status).toBe(200);
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
    expect(harness.mail.outbox).toHaveLength(1);
  });

  // #99-SR-09
  it("answers an address outside the rule like an allowed one, and creates nothing and sends nothing", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "emails", entries: [ADDRESS] },
    });
    const before = await harness.counts();

    const listed = await readAnswer(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );
    const outside = await readAnswer(
      await harness.signUp({
        email: "stranger@evil.example",
        password: SIGNUP_TEST_PASSWORD,
      }),
    );
    await harness.flush();

    expect(outside).toEqual(listed);
    expect(await harness.user("stranger@evil.example")).toBeUndefined();
    expect((await harness.counts()).users).toBe(before.users + 1);
    expect(harness.mail.to("stranger@evil.example")).toEqual([]);
    expect(JSON.stringify(outside)).not.toContain(ADDRESS);
  });

  it("lets a domain rule in the address of that domain and not a subdomain", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "domains", entries: ["corp.example"] },
    });

    for (const email of ["a@corp.example", "b@sub.corp.example"])
      await harness.signUp({ email, password: SIGNUP_TEST_PASSWORD });
    await harness.flush();

    expect(await harness.user("a@corp.example")).toBeDefined();
    expect(await harness.user("b@sub.corp.example")).toBeUndefined();
  });

  // #99-SR-06
  it.each([
    { kind: "emails", entries: [ADDRESS] },
    { kind: "domains", entries: ["example.com"] },
  ] as const)(
    "is closed for a $kind rule without a mail server, even for a listed address, and the admin still signs in",
    async (rule) => {
      const harness = await createSignUpHarness({
        mail: false,
        rule: { ...rule, entries: [...rule.entries] },
      });
      const before = await harness.counts();

      const response = await harness.signUp({
        email: ADDRESS,
        password: SIGNUP_TEST_PASSWORD,
      });
      await harness.flush();

      expect(await readAnswer(response)).toMatchObject({
        status: 403,
        body: { error: "signup_closed" },
      });
      expect(await harness.counts()).toEqual(before);
      expect(harness.mail.outbox).toEqual([]);
      const admin = await harness.auth.api.signInEmail({
        body: harness.admin,
      });
      expect(admin.user.email).toBe(harness.admin.email);
    },
  );

  // #99-SR-07
  it("opens when a mail server is added and closes again when it is removed, without touching existing accounts", async () => {
    const harness = await createSignUpHarness({
      mail: true,
      rule: { kind: "domains", entries: ["example.com"] },
    });
    await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
    await harness.flush();
    await harness.verify({
      token: harness.mail.lastToken(ADDRESS),
      password: SIGNUP_TEST_PASSWORD,
    });

    harness.mail.configured = false;
    const closed = await readAnswer(
      await harness.signUp({
        email: "second@example.com",
        password: SIGNUP_TEST_PASSWORD,
      }),
    );
    harness.mail.configured = true;
    const open = await harness.signUp({
      email: "second@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(closed).toMatchObject({
      status: 403,
      body: { error: "signup_closed" },
    });
    expect(open.status).toBe(200);
    expect(await harness.user(ADDRESS)).toBeDefined();
    expect(await harness.user("second@example.com")).toBeDefined();
    const existing = await harness.auth.api.signInEmail({
      body: { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
    });
    expect(existing.user.email).toBe(ADDRESS);
  });

  // #99-SR-07
  it("closes again when email with password is switched on for a GitHub only instance that has no mail server", async () => {
    const harness = await createSignUpHarness({
      mail: false,
      rule: { kind: "domains", entries: ["example.com"] },
      githubConfigured: true,
    });
    const attempt = () =>
      harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });

    await harness.settings.set(
      "sign_in_methods",
      { emailPassword: false, github: true },
      null,
    );
    const githubOnly = await readAnswer(await attempt());
    await harness.settings.set(
      "sign_in_methods",
      { emailPassword: true, github: true },
      null,
    );
    const both = await readAnswer(await attempt());

    expect(githubOnly).toMatchObject({
      status: 403,
      body: { error: "sign_up_disabled" },
    });
    expect(both).toMatchObject({
      status: 403,
      body: { error: "signup_closed" },
    });
  });

  // #99-SR-17
  it("lets existing accounts sign in after the rule is made stricter, and applies the new rule to the next sign-up", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
    await harness.flush();
    await harness.verify({
      token: harness.mail.lastToken(ADDRESS),
      password: SIGNUP_TEST_PASSWORD,
    });

    await harness.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["only@example.com"] },
      null,
    );
    await harness.signUp({
      email: "late@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await harness.flush();

    expect(
      (
        await harness.auth.api.signInEmail({
          body: { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
        })
      ).user.email,
    ).toBe(ADDRESS);
    expect(await harness.user("late@example.com")).toBeUndefined();
  });

  it("treats nothing saved for the rule as a rule that lets nobody in", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.db
      .deleteFrom("instance_settings")
      .where("key", "=", "sign_up_rule")
      .execute();

    await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
    await harness.flush();

    expect(await harness.user(ADDRESS)).toBeUndefined();
  });
});

describe("the form of a sign-up", () => {
  // #99-SR-18
  it.each([
    ["short", "password_too_short"],
    ["a".repeat(PASSWORD_MAX_LENGTH + 1), "password_too_long"],
    ["password1234", "password_too_common"],
  ])(
    "refuses the password %j with %s and creates nothing",
    async (password, code) => {
      const harness = await createSignUpHarness({ mail: true });
      const before = await harness.counts();

      const answer = await readAnswer(
        await harness.signUp({ email: ADDRESS, password }),
      );

      expect(answer).toEqual({
        status: 422,
        retryAfter: null,
        body: { error: "invalid_input", issues: [{ field: "password", code }] },
      });
      expect(await harness.counts()).toEqual(before);
    },
  );

  // #99-SR-18
  it("does not check the password against the email address, like the setup", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp({
      email: "tester.person@example.com",
      password: "tester.person@example.com",
    });

    expect(response.status).toBe(200);
  });

  // #99-SR-04
  it.each(["a@", "@b.com", "a b@example.com", "a@b@example.com", "", 5, null])(
    "refuses the address %j as invalid_email",
    async (email) => {
      const harness = await createSignUpHarness({ mail: true });

      const answer = await readAnswer(
        await harness.signUp({ email, password: SIGNUP_TEST_PASSWORD }),
      );

      expect(answer).toMatchObject({
        status: 422,
        body: {
          error: "invalid_input",
          issues: [{ field: "email", code: "invalid_email" }],
        },
      });
    },
  );

  // #99-SR-14
  it("reads the request as JSON only, so a form encoded body never reaches the account", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const before = await harness.counts();

    const form = await harness.handlers.signUp(
      harness.post(
        "/api/sign-up",
        `email=${encodeURIComponent(ADDRESS)}&password=${SIGNUP_TEST_PASSWORD}`,
        { "content-type": "application/x-www-form-urlencoded" },
      ),
    );
    const plain = await harness.handlers.signUp(
      harness.post(
        "/api/sign-up",
        JSON.stringify({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
        {
          "content-type": "text/plain",
        },
      ),
    );

    expect(form.status).toBe(415);
    expect(plain.status).toBe(415);
    expect(await harness.counts()).toEqual(before);
    const counters = await harness.db
      .selectFrom("rate_limits")
      .select("key")
      .execute();
    expect(counters).toEqual([]);
  });

  it("refuses a request from another site", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp(
      { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
      { "sec-fetch-site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
    expect(await harness.user(ADDRESS)).toBeUndefined();
  });

  it("refuses a body over the limit", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp(
      JSON.stringify({ email: ADDRESS, password: "x".repeat(10_000) }),
    );

    expect(response.status).toBe(413);
  });
});

describe("the limit on signing up", () => {
  // #99-SR-13
  it("refuses the 11th attempt for an address with 429 and Retry-After, the same for an address that has an account", async () => {
    const harness = await createSignUpHarness({ mail: false });
    await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
    const attempt = (email: string) =>
      harness.signUp({ email, password: SIGNUP_TEST_PASSWORD });

    const known = [];
    const unknown = [];
    for (let i = 0; i < 12; i += 1) {
      known.push((await readAnswer(await attempt(ADDRESS))).status);
      unknown.push(
        (await readAnswer(await attempt("nobody@example.com"))).status,
      );
    }

    expect(known.filter((status) => status === 429).length).toBeGreaterThan(0);
    // 1 sign-up above plus 12 more is 13 attempts for the known address, 12 for the other.
    expect(known.indexOf(429)).toBe(9);
    expect(unknown.indexOf(429)).toBe(10);
    const refused = await readAnswer(await attempt(ADDRESS));
    expect(refused).toMatchObject({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  // #99-SR-13
  it("counts the mails of an address across the sign-up and the resend", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD });
    for (let i = 0; i < 4; i += 1) await harness.resend({ email: ADDRESS });

    const resend = await readAnswer(await harness.resend({ email: ADDRESS }));
    const signUp = await readAnswer(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(resend.status).toBe(429);
    expect(signUp.status).toBe(429);
  });
});

describe("what a sign-up leaves in answers and logs", () => {
  // #99-SR-20
  it("holds no password, token or verification link in any answer or log line of the whole flow", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const harness = await createSignUpHarness({ mail: true });
    const answers: string[] = [];
    const take = async (response: Response) => {
      answers.push(
        JSON.stringify([...response.headers]),
        await response.text(),
      );
    };

    await take(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );
    await harness.flush();
    const link = harness.mail.lastLink(ADDRESS);
    const token = harness.mail.lastToken(ADDRESS);
    await take(await harness.resend({ email: ADDRESS }));
    await harness.flush();
    const newToken = harness.mail.lastToken(ADDRESS);
    await take(
      await harness.signUp({ email: ADDRESS, password: SIGNUP_TEST_PASSWORD }),
    );
    await take(await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }));
    await take(
      await harness.verify({ token: newToken, password: SIGNUP_TEST_PASSWORD }),
    );
    harness.mail.failNext();
    await harness.resend({ email: ADDRESS });
    await harness.flush();

    const captured = [
      ...answers,
      ...harness.logs,
      ...spies.flatMap((spy) => spy.mock.calls.flat().map(String)),
    ].join("\n");
    for (const secret of [
      SIGNUP_TEST_PASSWORD,
      token,
      newToken,
      link,
      "token=",
    ])
      expect(captured).not.toContain(secret);
  });
});
