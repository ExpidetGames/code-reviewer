// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down, through the real handler, that the endpoints Better Auth offers beyond the GitHub
// sign in cannot be used: a signed in person cannot rewrite their own profile (which would let them
// claim another GitHub login), cannot read their session token, and there is no second way in.
import { describe, expect, it } from "vitest";
import { createAuthHarness } from "../test-support/auth-harness.ts";
import { handleAuth } from "../test-support/sign-in-limiter.ts";

describe("the HTTP interface of Better Auth", () => {
  // CR-18-T14
  it("does not let a signed in person change their GitHub login or read their session token", async () => {
    const harness = await createAuthHarness();
    const { cookies } = await harness.signIn("octocat");
    const send = (path: string, method: string, body?: unknown) =>
      harness.request(path, {
        method,
        cookies,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const update = await send("/api/auth/update-user", "POST", {
      githubLogin: "somebody-else",
      name: "Hacker",
    });
    const session = await send("/api/auth/get-session", "GET");
    const sessions = await send("/api/auth/list-sessions", "GET");

    // The test calls the auth handler directly, as `handleAuthRequest` does after its own check.
    expect([update.status, session.status, sessions.status]).not.toContain(500);
    const guarded = (path: string, method: string) =>
      handleAuth(
        harness.auth,
        new Request(`http://localhost:3000${path}`, {
          method,
          headers: {
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            origin: "http://localhost:3000",
          },
        }),
      );
    expect((await guarded("/api/auth/update-user", "POST")).status).toBe(404);
    expect((await guarded("/api/auth/get-session", "GET")).status).toBe(404);
    expect((await guarded("/api/auth/list-sessions", "GET")).status).toBe(404);
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      github_login: "octocat",
      name: "The Octocat",
    });
  });

  it("offers no sign in with an email address", async () => {
    const harness = await createAuthHarness();

    const signUp = await handleAuth(
      harness.auth,
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email: "a@example.test",
          password: "correct horse battery",
          name: "A",
        }),
      }),
    );

    expect(signUp.status).toBe(404);
    expect(await harness.db.selectFrom("users").selectAll().execute()).toEqual(
      [],
    );
  });
});
