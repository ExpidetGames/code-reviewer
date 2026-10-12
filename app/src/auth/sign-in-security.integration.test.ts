// SPDX-License-Identifier: Apache-2.0

// Pins down the security properties of a finished sign in: how the session cookie is set, that no
// secret (client secret, GitHub access token, session token) leaks into logs, responses or
// redirect addresses, that the GitHub token is not stored in the clear, and that a sign in cannot
// be started by another site.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_CLIENT_SECRET,
  createAuthHarness,
} from "../test-support/auth-harness.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureConsole(): () => string {
  const lines: string[] = [];
  const show = (value: unknown): string =>
    value instanceof Error
      ? `${value.message}\n${value.stack ?? ""}\n${show(value.cause)}`
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(show).join(" "));
    });
  }
  return () => lines.join("\n");
}

describe("the session cookie of a finished sign in", () => {
  // CR-18-T13
  it("is HttpOnly, Secure and SameSite=Lax, and lasts 30 days, in production mode", async () => {
    const harness = await createAuthHarness({ secureCookies: true });

    const { response } = await harness.signIn();

    const cookie = response.headers
      .getSetCookie()
      .find((line) => line.includes("session_token"));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).toMatch(/;\s*Max-Age=2592000(;|$)/i);
    const session = await harness.db
      .selectFrom("sessions")
      .selectAll()
      .executeTakeFirstOrThrow();
    const lifetimeMs =
      new Date(session.expires_at).getTime() -
      new Date(session.created_at).getTime();
    expect(Math.abs(lifetimeMs - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1000);
  });
});

describe("secrets during a sign in", () => {
  // CR-18-T14
  it("never appear in logs, responses or redirect addresses", async () => {
    const logged = captureConsole();
    const harness = await createAuthHarness();
    const seen: string[] = [];

    const start = await harness.startSignIn();
    seen.push(start.authorizeUrl ?? "", start.bodyText);
    const callbackUrl = await harness.github.authorize(
      start.authorizeUrl!,
      "octocat",
    );
    seen.push(callbackUrl.toString());
    const finished = await harness.callback(callbackUrl, start.cookies);
    seen.push(finished.headers.get("location") ?? "", await finished.text());
    // A failing exchange logs the most, so it is searched too.
    harness.github.failTokenEndpoint({ kind: "status", status: 500 });
    const failedStart = await harness.startSignIn();
    const failedCallback = await harness.github.authorize(
      failedStart.authorizeUrl!,
      "octocat",
    );
    const failed = await harness.callback(failedCallback, failedStart.cookies);
    seen.push(failed.headers.get("location") ?? "", await failed.text());
    const sessionTokens = (
      await harness.db.selectFrom("sessions").select("token").execute()
    ).map((row) => row.token);
    const signOut = await harness.request("/api/auth/sign-out", {
      method: "POST",
      cookies: start.cookies,
    });
    seen.push(await signOut.text());

    const accessTokens = harness.github.issuedAccessTokens();
    expect(accessTokens.length).toBeGreaterThan(0);
    const everythingSeen = [...seen, logged()].join("\n");
    for (const secret of [
      TEST_CLIENT_SECRET,
      ...accessTokens,
      ...sessionTokens,
    ]) {
      expect(everythingSeen).not.toContain(secret);
    }
  });

  // CR-18-T14
  it("does not keep the GitHub access token in the database, not even after a second sign in", async () => {
    const harness = await createAuthHarness();

    await harness.signIn();
    await harness.signIn();

    expect(harness.github.issuedAccessTokens().length).toBeGreaterThan(0);
    const account = await harness.db
      .selectFrom("accounts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account.access_token).toBeNull();
    expect(account.refresh_token).toBeNull();
    expect(account.id_token).toBeNull();
  });
});

describe("a request that comes from another site", () => {
  // CR-18-T09
  it("cannot sign a person out: the request with their cookie is refused and the session stays", async () => {
    const harness = await createAuthHarness();
    const { cookies } = await harness.signIn();

    const response = await harness.request("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookies,
    });

    expect(response.status).toBe(403);
    expect(
      await harness.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
  });
});
