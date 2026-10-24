// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the lost admin password without a mail server, end to end over a real database and the real
// Better Auth: `admin reset-password` prints a link, the link sets a new password once within 30
// minutes under the password rule and ends the sessions of the account, and a link that was used,
// expired, changed or never made changes nothing. The token is stored only as a hash; the data route is
// rate limited and refuses other sites.
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runCli } from "../admin-cli/cli.ts";
import { hashResetToken, newResetToken } from "../admin-cli/token.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  createAdminHarness,
  ADMIN_TEST_BASE_URL,
  ADMIN_TEST_CREDENTIALS,
} from "../test-support/admin-harness.ts";
import { completePasswordReset, isKnownResetToken } from "./password-reset.ts";
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_WINDOW_MS,
  createPasswordResetHandler,
} from "./password-reset-http.ts";

const NEW_PASSWORD = "n3w-Passphrase-orbit-lantern";

async function startInstance() {
  const portal = await createAdminHarness();
  let now = new Date("2026-10-11T12:00:00.000Z");
  const handler = createPasswordResetHandler({
    rateLimits: createRateLimitsRepository(portal.db, () => now),
    isKnownToken: (token) => isKnownResetToken(portal.db, token),
    complete: async (input) =>
      completePasswordReset(
        {
          db: portal.db,
          hashPassword: (await portal.auth.$context).password.hash,
          now: () => now,
        },
        input,
      ),
    now: () => now,
  });

  /** What the operator does in the container: the command prints the link. */
  function operatorMakesLink(email: string = ADMIN_TEST_CREDENTIALS.email) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(
      ["reset-password", email],
      {
        DATABASE_PATH: portal.databasePath,
        BETTER_AUTH_URL: ADMIN_TEST_BASE_URL,
      },
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      () => now,
    );
    const link = out.find((line) => line.startsWith("http"));
    return {
      code,
      err,
      link,
      token:
        link === undefined
          ? ""
          : (new URL(link).searchParams.get("token") ?? ""),
    };
  }

  function post(body: unknown, headers: Record<string, string> = {}) {
    return handler(
      new Request(`${ADMIN_TEST_BASE_URL}/api/password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  async function passwordHash() {
    const row = await portal.db
      .selectFrom("accounts")
      .select("password")
      .where("user_id", "=", portal.adminId)
      .where("provider_id", "=", "credential")
      .executeTakeFirstOrThrow();
    return row.password;
  }

  async function canSignIn(password: string) {
    const response = await portal.auth.api
      .signInEmail({
        body: { email: ADMIN_TEST_CREDENTIALS.email, password },
        asResponse: true,
      })
      .catch(() => null);
    return response?.ok === true;
  }

  return {
    portal,
    handler,
    operatorMakesLink,
    post,
    passwordHash,
    canSignIn,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("a lost admin password without a mail server", () => {
  // #98-AD-17
  it("is recovered with the printed link: the new password works, the old one does not, and the sessions end", async () => {
    const { portal, operatorMakesLink, post, canSignIn } =
      await startInstance();
    const { token, code } = operatorMakesLink();
    const before = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    const response = await post({ token, password: NEW_PASSWORD });

    expect(code).toBe(0);
    expect(before.status).toBe(200);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(
      await portal.db.selectFrom("sessions").selectAll().execute(),
    ).toEqual([]);
    const after = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    expect(after.status).toBe(401);
    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
    expect(await canSignIn(ADMIN_TEST_CREDENTIALS.password)).toBe(false);
  });

  // #98-AD-17
  it("sets the new password under the password rule: a short or common one is refused and the link stays good", async () => {
    const { operatorMakesLink, post, canSignIn, passwordHash } =
      await startInstance();
    const { token } = operatorMakesLink();
    const hashBefore = await passwordHash();

    const tooShort = await post({ token, password: "short" });
    const common = await post({ token, password: "password1234" });
    const hashAfterRefusals = await passwordHash();
    const stillGood = await post({ token, password: NEW_PASSWORD });

    expect(tooShort.status).toBe(422);
    expect(await tooShort.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "password", code: "password_too_short" }],
    });
    expect(await common.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "password", code: "password_too_common" }],
    });
    expect(hashAfterRefusals).toBe(hashBefore);
    expect(stillGood.status).toBe(200);
    expect(await passwordHash()).not.toBe(hashBefore);
    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
  });

  // #98-AD-18
  it("works once: the same link used again changes nothing", async () => {
    const { operatorMakesLink, post, canSignIn } = await startInstance();
    const { token } = operatorMakesLink();
    await post({ token, password: NEW_PASSWORD });

    const again = await post({ token, password: "an0ther-Passphrase-delta" });

    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_token" });
    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
    expect(await canSignIn("an0ther-Passphrase-delta")).toBe(false);
  });

  // #98-AD-18
  it("works for 30 minutes and not for 31", async () => {
    const lastMinute = await startInstance();
    const inTime = lastMinute.operatorMakesLink();
    lastMinute.advance(29 * 60 * 1000 + 59 * 1000);
    const accepted = await lastMinute.post({
      token: inTime.token,
      password: NEW_PASSWORD,
    });

    const late = await startInstance();
    const expired = late.operatorMakesLink();
    const hashBefore = await late.passwordHash();
    late.advance(31 * 60 * 1000);
    const refused = await late.post({
      token: expired.token,
      password: NEW_PASSWORD,
    });

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_token" });
    expect(await late.passwordHash()).toBe(hashBefore);
    expect(await late.canSignIn(ADMIN_TEST_CREDENTIALS.password)).toBe(true);
  });

  // #98-AD-18
  it.each([
    [
      "a token that was changed",
      (token: string) =>
        `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    ],
    ["a token with a character cut off", (token: string) => token.slice(0, -1)],
    ["a token with something added", (token: string) => `${token}x`],
    ["a token that was never made", () => newResetToken()],
    ["an empty token", () => ""],
  ])("refuses %s and changes nothing", async (_name, damage) => {
    const { operatorMakesLink, post, canSignIn, passwordHash } =
      await startInstance();
    const { token } = operatorMakesLink();
    const hashBefore = await passwordHash();

    const response = await post({
      token: damage(token),
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    expect(await passwordHash()).toBe(hashBefore);
    expect(await canSignIn(ADMIN_TEST_CREDENTIALS.password)).toBe(true);
  });

  // #98-AD-18
  it("works up to the last moment and is refused at exactly 30:00", async () => {
    const atTheEdge = await startInstance();
    const last = atTheEdge.operatorMakesLink();
    atTheEdge.advance(30 * 60 * 1000 - 1);
    const accepted = await atTheEdge.post({
      token: last.token,
      password: NEW_PASSWORD,
    });

    const exactly = await startInstance();
    const link = exactly.operatorMakesLink();
    exactly.advance(30 * 60 * 1000);
    const refused = await exactly.post({
      token: link.token,
      password: NEW_PASSWORD,
    });

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_token" });
  });

  // #98-AD-17
  it.each([
    ["129 characters", "a".repeat(129)],
    ["65 emoji, which are 130 UTF-16 code units", "\u{1F600}".repeat(65)],
  ])(
    "refuses a new password of %s as too long and keeps the link good",
    async (_name, password) => {
      const { operatorMakesLink, post, passwordHash } = await startInstance();
      const { token } = operatorMakesLink();
      const hashBefore = await passwordHash();

      const response = await post({ token, password });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        issues: [{ field: "password", code: "password_too_long" }],
      });
      expect(await passwordHash()).toBe(hashBefore);
      expect((await post({ token, password: NEW_PASSWORD })).status).toBe(200);
    },
  );

  // #98-AD-18
  it("stores the token only as a hash", async () => {
    const { portal, operatorMakesLink } = await startInstance();

    const { token } = operatorMakesLink();

    const raw = new BetterSqlite3(portal.databasePath, { readonly: true });
    const rows = raw.prepare("select * from password_reset_tokens").all();
    raw.close();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows).toEqual([
      expect.objectContaining({ token_hash: hashResetToken(token) }),
    ]);
  });

  // #98-AD-18
  it("is reported as unknown for an email address that has no account, and nothing is made", async () => {
    const { portal, operatorMakesLink } = await startInstance();

    const result = operatorMakesLink("nobody@example.com");

    expect(result.code).toBe(1);
    expect(result.link).toBeUndefined();
    expect(result.err.join()).toContain("UNKNOWN_ACCOUNT");
    expect(
      await portal.db.selectFrom("password_reset_tokens").selectAll().execute(),
    ).toEqual([]);
  });

  // #99-SR-12
  it("drops the pending verification links of the account, which would put the old password back", async () => {
    const { portal, operatorMakesLink, post } = await startInstance();
    const { token } = operatorMakesLink();
    await portal.db
      .insertInto("email_verification_tokens")
      .values({
        token_hash: "e".repeat(64),
        user_id: portal.adminId,
        email: "admin@example.com",
        password_hash: "old-hash",
        created_at: "2026-10-11T08:00:00.000Z",
        expires_at: "2026-10-12T08:00:00.000Z",
        used_at: null,
      })
      .execute();

    await post({ token, password: NEW_PASSWORD });

    expect(
      await portal.db
        .selectFrom("email_verification_tokens")
        .selectAll()
        .execute(),
    ).toEqual([]);
  });

  it("lets a new link replace the old one, which then stops working", async () => {
    const { operatorMakesLink, post, canSignIn } = await startInstance();
    const first = operatorMakesLink();
    const second = operatorMakesLink();

    const old = await post({ token: first.token, password: NEW_PASSWORD });
    const fresh = await post({ token: second.token, password: NEW_PASSWORD });

    expect(old.status).toBe(400);
    expect(fresh.status).toBe(200);
    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
  });

  it("uses a link up exactly once when two requests arrive at the same time", async () => {
    const { operatorMakesLink, post } = await startInstance();
    const { token } = operatorMakesLink();

    const answers = await Promise.all([
      post({ token, password: NEW_PASSWORD }),
      post({ token, password: "an0ther-Passphrase-delta" }),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
  });
});

describe("the data route behind the link", () => {
  it("refuses a request from another site and a body that is not JSON, and uses nothing up", async () => {
    const { operatorMakesLink, post, portal } = await startInstance();
    const { token } = operatorMakesLink();

    const crossSite = await post(
      { token, password: NEW_PASSWORD },
      { "sec-fetch-site": "cross-site" },
    );
    const notJson = await post(`token=${token}`, {
      "content-type": "text/plain",
    });

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
    expect(notJson.status).toBe(415);
    const [row] = await portal.db
      .selectFrom("password_reset_tokens")
      .select("used_at")
      .execute();
    expect(row?.used_at).toBeNull();
  });

  it.each([
    ["no body", ""],
    ["a body that is not JSON", "{"],
    ["an array", "[]"],
    ["a body without a password", JSON.stringify({ token: "x" })],
    ["a body without a token", JSON.stringify({ password: NEW_PASSWORD })],
    [
      "a token that is not text",
      JSON.stringify({ token: 5, password: NEW_PASSWORD }),
    ],
  ])("refuses %s", async (_name, body) => {
    const { post } = await startInstance();

    const response = await post(body);

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_input",
    );
  });

  // #98-AD-18
  it("still accepts a valid link after 100 junk requests, which touch no counter", async () => {
    const { post, operatorMakesLink, portal, canSignIn } =
      await startInstance();
    const { token } = operatorMakesLink();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const junk = await post({ token: newResetToken(), password: "y" });
      expect(junk.status).toBe(400);
    }
    const response = await post({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
    const counters = await portal.db
      .selectFrom("rate_limits")
      .select("key")
      .execute();
    expect(
      counters.filter(({ key }) => key.startsWith("password-reset")),
    ).toEqual([
      { key: expect.stringMatching(/^password-reset:[0-9a-f]{64}$/) as string },
    ]);
  });

  it("limits the attempts against one link, whatever they say, and says when to try again", async () => {
    const { post, operatorMakesLink } = await startInstance();
    const { token } = operatorMakesLink();
    for (let attempt = 0; attempt < PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1) {
      const refused = await post({ token, password: "short" });
      expect(refused.status).toBe(422);
    }

    const limited = await post({ token, password: NEW_PASSWORD });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("does not let the attempts against one link stop another link", async () => {
    const { post, operatorMakesLink } = await startInstance();
    const old = operatorMakesLink();
    for (let attempt = 0; attempt <= PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1)
      await post({ token: old.token, password: "short" });
    const fresh = operatorMakesLink();

    const response = await post({ token: fresh.token, password: NEW_PASSWORD });

    expect(response.status).toBe(200);
  });

  it("counts the attempts of a link for as long as the link lives", async () => {
    const { post, operatorMakesLink, advance } = await startInstance();
    const { token } = operatorMakesLink();
    for (let attempt = 0; attempt <= PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1)
      await post({ token, password: "short" });
    advance(PASSWORD_RESET_WINDOW_MS - 1000);

    const stillLimited = await post({ token, password: NEW_PASSWORD });

    expect(stillLimited.status).toBe(429);
  });

  it("is a public route: a person without a session reaches it through the proxy", async () => {
    const { portal } = await startInstance();

    const response = await portal.visit("/api/password-reset", {
      method: "POST",
      body: { token: "x", password: "y" },
    });
    const page = await portal.visit("/reset-password?token=abc");

    expect(await response.text()).toBe("reached");
    expect(await page.text()).toBe("reached");
  });

  it("never puts the token or the password into an answer", async () => {
    const { post, operatorMakesLink } = await startInstance();
    const { token } = operatorMakesLink();

    const answers = await Promise.all([
      post({ token, password: "short" }),
      post({ token: `${token}x`, password: NEW_PASSWORD }),
      post({ token, password: NEW_PASSWORD }),
    ]);

    for (const answer of answers) {
      const text = JSON.stringify([...answer.headers]) + (await answer.text());
      expect(text).not.toContain(token);
      expect(text).not.toContain(NEW_PASSWORD);
    }
  });
});
