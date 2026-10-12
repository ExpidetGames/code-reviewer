// SPDX-License-Identifier: Apache-2.0

// Pins down the verification link and the request for a new one through the real route handlers, the
// real counters and a real SQLite file: a link verifies once, every way a link can be wrong is refused
// with a stable code and changes nothing, nothing says whether an address has an account, and junk can
// never use up the attempts of a valid link.
import { describe, expect, it, vi } from "vitest";
import {
  createSignUpHarness,
  SIGNUP_TEST_PASSWORD,
  type SignUpHarness,
} from "../test-support/signup-harness.ts";
import { VERIFICATION_TOKEN_TTL_MS } from "./verification-tokens.ts";

const ADDRESS = "newcomer@example.com";

async function answer(response: Response) {
  return {
    status: response.status,
    body: await response.json(),
    retryAfter: response.headers.get("retry-after"),
  };
}

async function signedUp(harness: SignUpHarness, email = ADDRESS) {
  await harness.signUp({ email, password: SIGNUP_TEST_PASSWORD });
  await harness.flush();
  return harness.mail.lastToken(email);
}

describe("opening a verification link", () => {
  // #99-SR-11
  it("verifies the address and only that address", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    await signedUp(harness, "other@example.com");

    const result = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect((await harness.user(ADDRESS))?.email_verified).toBe(1);
    expect((await harness.user("other@example.com"))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it("refuses a link that was used before, and nothing changes", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    await harness.verify({ token, password: SIGNUP_TEST_PASSWORD });

    const second = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(second).toMatchObject({
      status: 409,
      body: { error: "token_used" },
    });
    expect((await harness.user(ADDRESS))?.email_verified).toBe(1);
  });

  // #99-SR-12
  it("refuses a link older than 24 hours, and nothing changes", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);

    harness.advance(VERIFICATION_TOKEN_TTL_MS + 1000);
    const late = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(late).toMatchObject({
      status: 410,
      body: { error: "token_expired" },
    });
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it.each([
    ["a damaged token", (token: string) => `${token.slice(0, -2)}xx`],
    ["a token that is too short", (token: string) => token.slice(0, 20)],
    ["a made-up token", () => "A".repeat(43)],
    ["text that is not a token", () => "nonsense"],
  ])(
    "refuses %s with invalid_token and changes nothing",
    async (_name, spoil) => {
      const harness = await createSignUpHarness({ mail: true });
      const token = await signedUp(harness);

      const result = await answer(
        await harness.verify({
          token: spoil(token),
          password: SIGNUP_TEST_PASSWORD,
        }),
      );

      expect(result).toMatchObject({
        status: 400,
        body: { error: "invalid_token" },
      });
      expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
    },
  );

  it("refuses a body without a token and a token that is not text", async () => {
    const harness = await createSignUpHarness({ mail: true });

    for (const body of [{}, { token: 5 }, { token: null }, { token: ["x"] }])
      expect(await answer(await harness.verify(body))).toMatchObject({
        status: 400,
        body: { error: "invalid_token" },
      });
  });

  // #99-SR-12
  it("refuses the link of another user when somebody else is signed in, and the link stays valid", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    const other = await harness.user(harness.admin.email);
    harness.session.userId = other?.id ?? null;

    const wrongSession = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );
    harness.session.userId = (await harness.user(ADDRESS))?.id ?? null;
    const ownSession = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(wrongSession).toMatchObject({
      status: 400,
      body: { error: "invalid_token" },
    });
    expect(ownSession).toMatchObject({ status: 200 });
    expect((await harness.user(harness.admin.email))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it("verifies without a session at all: the link is the credential", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    harness.session.userId = null;

    expect(
      (await harness.verify({ token, password: SIGNUP_TEST_PASSWORD })).status,
    ).toBe(200);
  });

  // #99-SR-12
  it("needs a JSON body from the same site, so a form post or another site cannot use a link", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);

    const form = await harness.handlers.verify(
      harness.post("/api/verify-email", `token=${token}`, {
        "content-type": "application/x-www-form-urlencoded",
      }),
    );
    const cross = await harness.verify(
      { token, password: SIGNUP_TEST_PASSWORD },
      { "sec-fetch-site": "cross-site" },
    );

    expect(form.status).toBe(415);
    expect(cross.status).toBe(403);
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it("stops counting a link after 10 attempts, and junk never counts against a valid link", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    const junk = Array.from(
      { length: 60 },
      (_v, i) => `${String(i).padStart(2, "0")}${"J".repeat(41)}`,
    );
    for (const attempt of junk)
      await harness.verify({ token: attempt, password: SIGNUP_TEST_PASSWORD });

    const valid = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(valid.status).toBe(200);
    const counters = await harness.db
      .selectFrom("rate_limits")
      .select("key")
      .where("key", "like", "verify-email:%")
      .execute();
    // Only the link that exists has a counter.
    expect(counters).toHaveLength(1);
  });

  // #99-SR-12
  it("refuses the 11th attempt at one link with 429 and Retry-After", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    await harness.verify({ token, password: SIGNUP_TEST_PASSWORD });

    const results = [];
    for (let i = 0; i < 11; i += 1)
      results.push(
        await answer(
          await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
        ),
      );

    expect(results.slice(0, 9).every((r) => r.status === 409)).toBe(true);
    expect(results[9]).toMatchObject({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(Number(results[9]?.retryAfter)).toBeGreaterThan(0);
  });

  it("does not serve a request when the counters cannot be reached", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    await harness.db.schema.dropTable("rate_limits").execute();

    const result = await answer(
      await harness.verify({ token, password: SIGNUP_TEST_PASSWORD }),
    );

    expect(result).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
  });
});

describe("asking for a new verification link", () => {
  // #99-SR-13
  it("sends a link to an account that waits for verification, and using one stops the other", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const first = await signedUp(harness);

    const response = await answer(await harness.resend({ email: ADDRESS }));
    await harness.flush();
    const second = harness.mail.lastToken(ADDRESS);

    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(harness.mail.to(ADDRESS)).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(
      (await harness.verify({ token: second, password: SIGNUP_TEST_PASSWORD }))
        .status,
    ).toBe(200);
    expect(
      (await harness.verify({ token: first, password: SIGNUP_TEST_PASSWORD }))
        .status,
    ).toBe(400);
  });

  // #99-SR-13
  it("answers an unknown address exactly like a known one, and sends nothing to it", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);

    const known = await answer(await harness.resend({ email: ADDRESS }));
    const unknown = await answer(
      await harness.resend({ email: "nobody@example.com" }),
    );
    await harness.flush();

    expect(unknown).toEqual(known);
    expect(harness.mail.to("nobody@example.com")).toEqual([]);
  });

  // #143
  it("looks at no account before the answer is on its way, for a known address and an unknown one alike", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    const touched = new Set<string>();
    const executor = harness.db.getExecutor();
    const original = executor.transformQuery.bind(executor);
    const spy = vi
      .spyOn(executor, "transformQuery")
      .mockImplementation((node, queryId) => {
        const text = JSON.stringify(node);
        for (const table of ["users", "accounts", "email_verification_tokens"])
          if (text.includes(`"name":"${table}"`)) touched.add(table);
        return original(node, queryId);
      });

    const known = await answer(await harness.resend({ email: ADDRESS }));
    const unknown = await answer(
      await harness.resend({ email: "nobody@example.com" }),
    );
    spy.mockRestore();

    expect(unknown).toEqual(known);
    expect([...touched]).toEqual([]);
    expect(harness.waiting()).toBe(2);
    expect(harness.mail.outbox).toHaveLength(1);
    await harness.flush();
    expect(harness.mail.to(ADDRESS)).toHaveLength(2);
    expect(harness.mail.to("nobody@example.com")).toEqual([]);
  });

  // #99-SR-13
  it("is rate limited the same way for a known and an unknown address", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);

    const known = [];
    const unknown = [];
    for (let i = 0; i < 8; i += 1) {
      known.push(await answer(await harness.resend({ email: ADDRESS })));
      unknown.push(
        await answer(await harness.resend({ email: "nobody@example.com" })),
      );
    }

    // The sign-up used one of the five mails of the known address.
    expect(known.map((r) => r.status)).toEqual([
      200, 200, 200, 200, 429, 429, 429, 429,
    ]);
    expect(unknown.map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200, 429, 429, 429,
    ]);
    expect(known[4]?.body).toEqual(unknown[5]?.body);
    expect(known[4]?.retryAfter).toBe(unknown[5]?.retryAfter);
  });

  it("sends no link to an account that is verified already, with the same answer", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const token = await signedUp(harness);
    await harness.verify({ token, password: SIGNUP_TEST_PASSWORD });
    const mails = harness.mail.outbox.length;

    const response = await answer(await harness.resend({ email: ADDRESS }));
    await harness.flush();

    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(harness.mail.outbox).toHaveLength(mails);
  });

  it("sends no link to an account without a password", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.db
      .insertInto("users")
      .values({
        id: "gh1",
        name: "octocat",
        email: "gh@example.com",
        email_verified: 0,
        image: null,
        github_login: "octocat",
        imported_at: null,
        is_instance_admin: 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: "2026-10-11T08:00:00.000Z",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();

    const response = await harness.resend({ email: "gh@example.com" });
    await harness.flush();

    expect(response.status).toBe(200);
    expect(harness.mail.outbox).toEqual([]);
  });

  // #99-SR-13
  it("answers 404 not_available for every address while the instance has no mail server", async () => {
    const harness = await createSignUpHarness({ mail: false });

    const known = await answer(
      await harness.resend({ email: harness.admin.email }),
    );
    const unknown = await answer(
      await harness.resend({ email: "nobody@example.com" }),
    );

    expect(known).toMatchObject({
      status: 404,
      body: { error: "not_available" },
    });
    expect(unknown).toEqual(known);
  });

  it("refuses an address that is not an address", async () => {
    const harness = await createSignUpHarness({ mail: true });

    for (const email of ["", "a@", 5, null])
      expect(await answer(await harness.resend({ email }))).toMatchObject({
        status: 422,
        body: { error: "invalid_input" },
      });
  });

  // #99-SR-14
  it("reads the request as JSON only", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);
    const mails = harness.mail.outbox.length;

    const form = await harness.handlers.resend(
      harness.post(
        "/api/verify-email/resend",
        `email=${encodeURIComponent(ADDRESS)}`,
        {
          "content-type": "application/x-www-form-urlencoded",
        },
      ),
    );
    await harness.flush();

    expect(form.status).toBe(415);
    expect(harness.mail.outbox).toHaveLength(mails);
  });

  it("sends a link to the configured address of the app, whatever Host header the request carries", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await signedUp(harness);

    await harness.resend(
      { email: ADDRESS },
      { host: "evil.example", "x-forwarded-host": "evil.example" },
    );
    await harness.flush();

    expect(
      harness.mail
        .lastLink(ADDRESS)
        .startsWith("http://localhost:3000/verify-email?token="),
    ).toBe(true);
  });
});
