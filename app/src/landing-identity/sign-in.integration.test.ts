// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity through the real sign-in (#692): the cookie the proxy set travels with the browser through the
// redirect to GitHub and back, and the callback (or the email form) stores it on the user, once, and clears the cookie.
// Real Better Auth, the fake GitHub and a real SQLite file.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OCTOCAT,
  createAuthHarness,
  type AuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { insertUser } from "../test-support/users.ts";
import {
  LANDING_IDENTITY_COOKIE,
  LANDING_IDENTITY_HOST_COOKIE,
} from "./identity.ts";

const DID = "0192f5f0-7c3e-7a52-9d1b-3f6a2c4e8b10";
const SID = "0192f5f0-7c3e-7a52-9d1b-aaaaaaaaaaaa";
const PASSWORD = "k9Pq-v3Xm7Rt";

afterEach(() => {
  vi.restoreAllMocks();
});

async function identityRows(harness: AuthHarness) {
  return harness.db
    .selectFrom("users")
    .select([
      "email",
      "posthog_distinct_id",
      "posthog_session_id",
      "posthog_captured_at",
    ])
    .orderBy("email")
    .execute();
}

/** A sign in with GitHub as `login`, with the landing cookie in the browser's jar from the start. */
async function signInWithLandingCookie(
  harness: AuthHarness,
  value: string | null,
  login = OCTOCAT.login,
) {
  const cookies: CookieJar = new Map();
  if (value !== null) cookies.set(LANDING_IDENTITY_COOKIE, value);
  const started = await harness.startSignIn({ callbackURL: "/" }, cookies);
  const callbackUrl = await harness.github.authorize(
    started.authorizeUrl ?? "",
    login,
  );
  const response = await harness.callback(callbackUrl, cookies);
  return { response, cookies };
}

describe("a new account made by the sign in with GitHub", () => {
  // #692-T04
  it("stores the identity the cookie carried through the redirect to GitHub and back, and clears the cookie", async () => {
    const harness = await createAuthHarness();

    const { response, cookies } = await signInWithLandingCookie(
      harness,
      `${DID}~${SID}`,
    );

    expect(response.status).toBe(302);
    const [row] = await identityRows(harness);
    expect(row).toMatchObject({
      posthog_distinct_id: DID,
      posthog_session_id: SID,
    });
    expect(row?.posthog_captured_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Gone from the browser: a later sign-in on the same browser carries nothing.
    expect(cookies.has(LANDING_IDENTITY_COOKIE)).toBe(false);
  });

  // #692-T06
  it("stores nothing without the cookie", async () => {
    const harness = await createAuthHarness();

    await signInWithLandingCookie(harness, null);

    expect(await identityRows(harness)).toEqual([
      {
        email: "octocat@example.test",
        posthog_distinct_id: null,
        posthog_session_id: null,
        posthog_captured_at: null,
      },
    ]);
  });

  // #692-T06
  it.each([
    ["an invalid identifier", "a%20b~c"],
    ["no separator", "abc"],
    ["too many parts", "a~b~c"],
    ["an over-long identifier", `${"x".repeat(201)}~`],
  ])(
    "stores nothing for a cookie with %s, and the sign in still works",
    async (_label, value) => {
      const harness = await createAuthHarness();

      const { response } = await signInWithLandingCookie(harness, value);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      expect((await identityRows(harness))[0]?.posthog_captured_at).toBeNull();
    },
  );
});

describe("a user that signs in with GitHub again", () => {
  // #692-T05
  it("gets the identity when they have none, and keeps the first one afterwards", async () => {
    const harness = await createAuthHarness();
    await signInWithLandingCookie(harness, null);

    await signInWithLandingCookie(harness, `${DID}~${SID}`);
    await signInWithLandingCookie(harness, "other-did~other-sid");

    expect(await identityRows(harness)).toMatchObject([
      { posthog_distinct_id: DID, posthog_session_id: SID },
    ]);
  });
});

describe("a user that signs in with email and password", () => {
  async function userWithPassword(harness: AuthHarness) {
    const hash = (await harness.auth.$context).password.hash;
    await insertUser(harness.db, {
      id: "u-pw",
      email: "pw@example.test",
      emailVerified: true,
      passwordHash: await hash(PASSWORD),
    });
  }
  const signIn = (harness: AuthHarness, cookie: string | null) =>
    harness.auth.api.signInEmail({
      body: { email: "pw@example.test", password: PASSWORD },
      headers: new Headers(cookie === null ? {} : { cookie }),
      returnHeaders: true,
    });

  // #692-T05
  it("gets the identity when they have none, once", async () => {
    const harness = await createAuthHarness();
    await userWithPassword(harness);

    const first = await signIn(
      harness,
      `${LANDING_IDENTITY_COOKIE}=${DID}~${SID}`,
    );
    await signIn(harness, `${LANDING_IDENTITY_COOKIE}=other~other`);

    expect(await identityRows(harness)).toMatchObject([
      { posthog_distinct_id: DID, posthog_session_id: SID },
    ]);
    expect(
      first.headers
        .getSetCookie()
        .some((line) => line.startsWith(`${LANDING_IDENTITY_COOKIE}=;`)),
    ).toBe(true);
  });

  // #692-T05
  it("reads the percent-encoded __Host- cookie of https and clears it with Secure", async () => {
    const harness = await createAuthHarness();
    await userWithPassword(harness);

    const response = await signIn(
      harness,
      `${LANDING_IDENTITY_HOST_COOKIE}=${encodeURIComponent("did:1")}~${encodeURIComponent("sid:1")}`,
    );

    expect(await identityRows(harness)).toMatchObject([
      { posthog_distinct_id: "did:1", posthog_session_id: "sid:1" },
    ]);
    expect(
      response.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${LANDING_IDENTITY_HOST_COOKIE}=;`)),
    ).toMatch(/Path=\/.*Secure/i);
  });

  // #692-T06
  it("stores nothing without the cookie", async () => {
    const harness = await createAuthHarness();
    await userWithPassword(harness);

    await signIn(harness, null);

    expect((await identityRows(harness))[0]?.posthog_captured_at).toBeNull();
  });
});

describe("what the app shows and logs", () => {
  // #692-T07
  it("does not put the identity in the session the app reads, nor in anything it logs", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    const harness = await createAuthHarness();

    const { cookies } = await signInWithLandingCookie(harness, `${DID}~${SID}`);
    const session = await harness.auth.api.getSession({
      headers: new Headers({
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      }),
    });

    expect(session?.user).toBeDefined();
    const text = JSON.stringify(session);
    expect(text).not.toContain(DID);
    expect(text).not.toContain(SID);
    expect(text).not.toMatch(/posthog/i);
    expect(logged.join("\n")).not.toContain(DID);
    expect(logged.join("\n")).not.toContain(SID);
  });
});
