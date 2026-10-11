// SPDX-License-Identifier: Apache-2.0

// Pins down the sign in with email and password against the real Better Auth instance and a real
// database: the instance admin the setup creates signs in, is recognized as the instance admin, needs
// no GitHub identity and no entry on the GitHub allow list, a wrong password and an unknown email get
// the same refusal, and the password rule holds on every path that sets a password.
import { describe, expect, it, vi } from "vitest";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_CODE,
  WIZARD_BODY,
} from "../test-support/setup-harness.ts";
import { cookieHeader, remember } from "../test-support/auth-harness.ts";
import { handleAuth } from "../test-support/sign-in-limiter.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { handleAuthRequest } from "./http.ts";
import { signInWithPasswordChecked } from "./password-sign-in.ts";
import { createSignInLimiter } from "./sign-in-limit.ts";
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
    const response = await handleAuth(
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

    const response = await handleAuth(
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

    const wrongPassword = await handleAuth(
      harness.auth,
      signInRequest(SETUP_TEST_ADMIN.email, "a-wrong-password-12"),
    );
    const unknown = await handleAuth(
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
      const response = await handleAuth(
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
    const response = await handleAuth(
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

describe("the limit on the sign in", () => {
  async function limited() {
    const { harness } = await setUpInstance();
    const limiter = createSignInLimiter(createRateLimitsRepository(harness.db));
    const post = (
      email: string,
      password: string,
      headers: Record<string, string> = {},
    ) =>
      handleAuthRequest(
        harness.auth,
        new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: SETUP_TEST_BASE_URL,
            ...headers,
          },
          body: JSON.stringify({ email, password }),
        }),
        limiter,
      );
    return { harness, limiter, post };
  }

  // #97-LIMIT
  it("refuses the 6th attempt of the HTTP endpoint, even with the right password and a new client address each time", async () => {
    const { post } = await limited();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1)
      statuses.push(
        (
          await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12", {
            "x-forwarded-for": `10.0.0.${String(attempt + 1)}`,
          })
        ).status,
      );
    const refused = await post(
      SETUP_TEST_ADMIN.email,
      SETUP_TEST_ADMIN.password,
      {
        "x-forwarded-for": "10.9.9.9",
      },
    );

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.getSetCookie()).toEqual([]);
  });

  // #97-LIMIT
  it("answers an unknown email address with the same statuses as a known one", async () => {
    const { post } = await limited();

    const known: number[] = [];
    const unknown: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      known.push(
        (await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12")).status,
      );
      unknown.push(
        (await post("nobody@example.com", "a-wrong-password-12")).status,
      );
    }

    expect(unknown).toEqual(known);
    expect(known).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  // #97-LIMIT
  it("counts the login form and the HTTP endpoint together", async () => {
    const { harness, limiter, post } = await limited();
    const form = () =>
      signInWithPasswordChecked(
        {
          limiter,
          signIn: (email, password) =>
            harness.auth.api.signInEmail({ body: { email, password } }),
          log: () => undefined,
        },
        SETUP_TEST_ADMIN.email,
        "a-wrong-password-12",
      );

    const outcomes = [await form(), await form(), await form()];
    const http = [
      (await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12")).status,
      (await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12")).status,
      (await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12")).status,
    ];

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(
      Array(3).fill("invalid_credentials"),
    );
    expect(http).toEqual([401, 401, 429]);
    expect((await form()).kind).toBe("rate_limited");
  });

  // #97-LIMIT
  it("forgets the failed attempts after a successful sign in", async () => {
    const { post } = await limited();
    for (let attempt = 0; attempt < 4; attempt += 1)
      await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12");

    expect(
      (await post(SETUP_TEST_ADMIN.email, SETUP_TEST_ADMIN.password)).status,
    ).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        (await post(SETUP_TEST_ADMIN.email, "a-wrong-password-12")).status,
      ).toBe(401);
  });

  it("does not let the endpoint of Better Auth answer for the instance when the counters cannot be read", async () => {
    const { harness } = await setUpInstance();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await handleAuthRequest(
      harness.auth,
      new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: SETUP_TEST_BASE_URL,
        },
        body: JSON.stringify({
          email: SETUP_TEST_ADMIN.email,
          password: SETUP_TEST_ADMIN.password,
        }),
      }),
      {
        check: () => Promise.reject(new Error("locked")),
        succeeded: () => Promise.resolve(),
      },
    );

    expect(response.status).toBe(503);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "SIGN_IN_LIMIT_UNAVAILABLE",
    );
  });

  // #97-LIMIT
  it.each([
    [
      "a form encoded body with a decoy first email",
      "application/x-www-form-urlencoded",
      `{"email":"rnd1&email=${encodeURIComponent(SETUP_TEST_ADMIN.email)}&password=guess&x=1"}`,
    ],
    [
      "a form encoded body with the real address",
      "application/x-www-form-urlencoded",
      `email=${encodeURIComponent(SETUP_TEST_ADMIN.email)}&password=guess`,
    ],
    [
      "multipart form data",
      "multipart/form-data; boundary=x",
      `--x\r\nContent-Disposition: form-data; name="email"\r\n\r\n${SETUP_TEST_ADMIN.email}\r\n--x\r\nContent-Disposition: form-data; name="password"\r\n\r\nguess\r\n--x--\r\n`,
    ],
    [
      "plain text that carries JSON",
      "text/plain",
      JSON.stringify({ email: SETUP_TEST_ADMIN.email, password: "guess" }),
    ],
    [
      "a vendor JSON type",
      "application/vnd.api+json",
      JSON.stringify({ email: SETUP_TEST_ADMIN.email, password: "guess" }),
    ],
    [
      "JSON hidden in a longer type",
      "text/plain; application/json",
      JSON.stringify({ email: SETUP_TEST_ADMIN.email, password: "guess" }),
    ],
    [
      "no content type at all",
      null,
      JSON.stringify({ email: SETUP_TEST_ADMIN.email, password: "guess" }),
    ],
  ])(
    "answers 415 for %s and never lets it reach Better Auth, so no body format can pick the counted address",
    async (_name, contentType, body) => {
      const { harness, limiter } = await limited();
      const handler = vi.fn(() => Promise.resolve(new Response("reached")));

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await handleAuthRequest(
          { handler },
          new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
            method: "POST",
            headers: {
              origin: SETUP_TEST_BASE_URL,
              ...(contentType === null ? {} : { "content-type": contentType }),
            },
            body,
          }),
          limiter,
        );
        statuses.push(response.status);
      }

      expect(statuses).toEqual(Array(8).fill(415));
      expect(handler).not.toHaveBeenCalled();
      // And with the real Better Auth: no session, and the admin's counter was not touched.
      const real = await handleAuthRequest(
        harness.auth,
        new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin: SETUP_TEST_BASE_URL,
            ...(contentType === null ? {} : { "content-type": contentType }),
          },
          body: body.replace("guess", SETUP_TEST_ADMIN.password),
        }),
        limiter,
      );
      expect(real.status).toBe(415);
      expect(real.headers.getSetCookie()).toEqual([]);
    },
  );

  // #97-LIMIT
  it("counts a JSON body on the address Better Auth signs in with, whatever the case of the type, a charset, or a repeated key", async () => {
    const { limiter } = await limited();
    const send = (contentType: string, body: string) =>
      handleAuthRequest(
        {
          handler: (request) =>
            // What Better Auth would read: the same bytes.
            request.text().then((text) => new Response(text, { status: 401 })),
        },
        new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": contentType, origin: SETUP_TEST_BASE_URL },
          body,
        }),
        limiter,
      );
    const admin = SETUP_TEST_ADMIN.email;
    const bodies: Array<[string, string]> = [
      ["application/json", JSON.stringify({ email: admin, password: "g" })],
      [
        "Application/JSON; charset=UTF-8",
        JSON.stringify({ email: admin.toUpperCase(), password: "g" }),
      ],
      [
        "application/json",
        `{"email":"decoy@example.com","email":"${admin}","password":"g"}`,
      ],
      [
        "application/json;charset=utf-8",
        JSON.stringify({ email: `  ${admin}`, password: "g" }),
      ],
      ["application/json", JSON.stringify({ email: admin, password: "g" })],
    ];

    const statuses: number[] = [];
    for (const [type, body] of bodies)
      statuses.push((await send(type, body)).status);
    const sixth = await send(
      "application/json",
      JSON.stringify({ email: admin, password: "g" }),
    );

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(sixth.status).toBe(429);
  });

  // #97-LIMIT
  it("hands Better Auth exactly the bytes it counted", async () => {
    const { limiter } = await limited();
    const original = JSON.stringify({
      email: "a@example.com",
      password: "p\u00e4ss",
    });
    let seen = "";

    await handleAuthRequest(
      {
        handler: async (request) => {
          seen = await request.text();
          return new Response("{}", { status: 401 });
        },
      },
      new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: SETUP_TEST_BASE_URL,
        },
        body: original,
      }),
      limiter,
    );

    expect(seen).toBe(original);
  });

  it("refuses a body that is too large before counting or signing in", async () => {
    const { limiter } = await limited();
    const handler = vi.fn(() => Promise.resolve(new Response("reached")));

    const response = await handleAuthRequest(
      { handler },
      new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "a@example.com",
          password: "x".repeat(20_000),
        }),
      }),
      limiter,
    );

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});
