// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the password reset by mail end to end over a real database, the real Better Auth, the real
// SMTP sender and the fake SMTP server: the mail with the link reaches the server, the answer is the same
// for an address with an account and one without (and does not wait for the mail), the limits cannot be
// used up by junk, the link works once within 30 minutes and ends the old password and every session, and
// without a mail server the whole thing does not exist.
import { describe, expect, it, vi } from "vitest";
import { hashResetToken } from "../admin-cli/token.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createSmtpMailSender } from "../mail/smtp-sender.ts";
import {
  PASSWORD_RESET_MAIL_GLOBAL_KEY,
  PASSWORD_RESET_MAIL_GLOBAL_MAX,
  PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
  PASSWORD_RESET_REQUEST_ADDRESS_MAX,
  createSignUpLimits,
} from "../signup/limits.ts";
import {
  ADMIN_TEST_BASE_URL,
  createAdminHarness,
} from "../test-support/admin-harness.ts";
import { startTestSmtp } from "../test-support/smtp-fake.ts";
import { completePasswordReset, isKnownResetToken } from "./password-reset.ts";
import { createPasswordResetHandler } from "./password-reset-http.ts";
import { requestPasswordReset } from "./password-reset-request.ts";
import { createPasswordResetRequestHandler } from "./password-reset-request-http.ts";

const QUICK = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};
const PERSON = {
  id: "person-1",
  email: "person@example.com",
  password: "k9Pq-v3Xm7Rt-first",
};
const NEW_PASSWORD = "n3w-Passphrase-orbit-lantern";

async function start(
  options: { smtp?: boolean; emailPassword?: boolean } = {},
) {
  const portal = await createAdminHarness();
  const smtp = await startTestSmtp({ tlsPort: null });
  let time = Date.parse("2026-10-12T08:00:00.000Z");
  const now = () => new Date(time);
  const logs: string[] = [];
  const pending: Array<() => Promise<void>> = [];

  if (options.smtp !== false)
    await portal.smtp.save(portal.adminId, {
      host: smtp.host,
      port: smtp.port,
      security: "starttls",
      allowSelfSigned: true,
      senderAddress: "reviewer@example.com",
      senderName: "code-review.com",
    });
  await portal.createUser({ ...PERSON, member: false });

  const rateLimits = createRateLimitsRepository(portal.db, now);
  const mail = createSmtpMailSender({
    config: portal.smtp,
    timeouts: QUICK,
    log: (line) => logs.push(line),
  });
  const request = createPasswordResetRequestHandler({
    request: (email) =>
      requestPasswordReset(
        {
          db: portal.db,
          mail,
          limits: createSignUpLimits(rateLimits, now),
          emailPasswordOn: () =>
            Promise.resolve(options.emailPassword !== false),
          baseUrl: ADMIN_TEST_BASE_URL,
          defer: (work) => {
            pending.push(work);
          },
          now,
          log: (line) => logs.push(line),
        },
        email,
      ),
    log: (line) => logs.push(line),
  });
  const complete = createPasswordResetHandler({
    rateLimits,
    isKnownToken: (token) => isKnownResetToken(portal.db, token),
    complete: async (input) =>
      completePasswordReset(
        {
          db: portal.db,
          hashPassword: (await portal.auth.$context).password.hash,
          now,
        },
        input,
      ),
    now,
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${ADMIN_TEST_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  return {
    portal,
    smtp,
    logs,
    rateLimits,
    ask: (email: unknown, headers?: Record<string, string>) =>
      request(post("/api/password-reset/request", { email }, headers)),
    reset: (token: string, password: string = NEW_PASSWORD) =>
      complete(post("/api/password-reset", { token, password })),
    flush: async () => {
      await Promise.all(pending.splice(0).map((work) => work()));
    },
    /** How many pieces of work wait for the answer to be sent. */
    waiting: () => pending.length,
    advance(ms: number) {
      time += ms;
    },
    tokenOf(message: { text: string } | undefined): string {
      const link = /https?:\/\/\S+/.exec(message?.text ?? "")?.[0];
      return link === undefined
        ? ""
        : (new URL(link).searchParams.get("token") ?? "");
    },
    async canSignIn(email: string, password: string) {
      try {
        await portal.signIn(email, password);
        return true;
      } catch {
        return false;
      }
    },
  };
}

describe("asking for a reset link by mail", () => {
  // #100-SM-10
  it("mails one link to an address with an account, and the answer is neutral", async () => {
    const { ask, flush, smtp, tokenOf, portal } = await start();

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.to).toEqual([PERSON.email]);
    expect(message?.subject).toBe("Reset your password");
    expect(message?.text).toContain(
      `${ADMIN_TEST_BASE_URL}/reset-password?token=`,
    );
    expect(message?.text).toContain("30 minutes");
    // The database holds the hash of the token and not the token; 256 bits; 30 minutes.
    const token = tokenOf(message);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await portal.db
      .selectFrom("password_reset_tokens")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashResetToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.user_id).toBe(PERSON.id);
    expect(
      Date.parse(rows[0]?.expires_at ?? "") -
        Date.parse(rows[0]?.created_at ?? ""),
    ).toBe(30 * 60 * 1000);
  });

  // #100-SM-11
  it("answers an unknown address, an address with no password and a known one exactly alike, and sends nothing for the first two", async () => {
    const { ask, flush, smtp, portal } = await start();
    await portal.db
      .deleteFrom("accounts")
      .where("user_id", "=", "person-1")
      .execute();
    await portal.db
      .insertInto("accounts")
      .values({
        id: "github-person",
        account_id: "999",
        provider_id: "github",
        user_id: "person-1",
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: "2026-10-12T00:00:00.000Z",
        updated_at: "2026-10-12T00:00:00.000Z",
      })
      .execute();

    const githubOnly = await ask(PERSON.email);
    const unknown = await ask("nobody@example.com");
    await flush();

    expect(smtp.messages).toEqual([]);
    expect(
      await portal.db.selectFrom("password_reset_tokens").selectAll().execute(),
    ).toEqual([]);
    expect(githubOnly.status).toBe(unknown.status);
    expect(await githubOnly.text()).toBe(await unknown.text());
    expect([...githubOnly.headers].sort()).toEqual([...unknown.headers].sort());
  });

  // #100-SM-11
  // #100-review-3
  it("starts no work on the account before the answer is on its way, for a known address and an unknown one alike", async () => {
    const { ask, flush, smtp, portal, rateLimits, waiting } = await start();
    const queries: string[] = [];
    // Every statement the database runs from here on is noted.
    const original = portal.db
      .getExecutor()
      .transformQuery.bind(portal.db.getExecutor());
    vi.spyOn(portal.db.getExecutor(), "transformQuery").mockImplementation(
      (node, queryId) => {
        queries.push(
          JSON.stringify(node).includes('"users"') ? "users" : "other",
        );
        return original(node, queryId);
      },
    );

    const known = await ask(PERSON.email);
    const unknown = await ask("nobody@example.com");

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    // The two requests did the same, and neither looked at an account, counted a mail or opened a connection.
    expect(queries).not.toContain("users");
    expect(waiting()).toBe(2);
    expect(smtp.sessions).toEqual([]);
    expect(
      await portal.db.selectFrom("password_reset_tokens").selectAll().execute(),
    ).toEqual([]);
    expect(
      (
        await rateLimits.hit(
          PASSWORD_RESET_MAIL_GLOBAL_KEY,
          PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
        )
      ).count,
    ).toBe(1);
    vi.restoreAllMocks();
    await flush();
    expect(smtp.messages).toHaveLength(1);
  });

  it("treats the spelling of the address as one address", async () => {
    const { ask, flush, smtp } = await start();

    await ask("  Person@Example.COM ");
    await flush();

    expect(smtp.messages[0]?.to).toEqual([PERSON.email]);
  });

  // #100-SM-14
  it("does not exist without a mail server: 404 for every address, no row, no mail", async () => {
    const { ask, flush, smtp, portal } = await start({ smtp: false });

    const known = await ask(PERSON.email);
    const unknown = await ask("nobody@example.com");
    await flush();

    expect(known.status).toBe(404);
    expect(await known.json()).toEqual({ error: "not_available" });
    expect(unknown.status).toBe(404);
    expect(smtp.sessions).toEqual([]);
    expect(
      await portal.db.selectFrom("password_reset_tokens").selectAll().execute(),
    ).toEqual([]);
  });

  it("does not exist while signing in with email and password is switched off", async () => {
    const { ask, flush, smtp } = await start({ emailPassword: false });

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(404);
    expect(smtp.sessions).toEqual([]);
  });

  it("is not available as soon as the mail server is removed", async () => {
    const { ask, portal } = await start();
    expect((await ask(PERSON.email)).status).toBe(200);

    await portal.smtp.remove();

    expect((await ask(PERSON.email)).status).toBe(404);
  });

  it("refuses an address that is not one, and one that tries to inject a header, before anything happens", async () => {
    const { ask, flush, smtp } = await start();

    const bad = await ask("not-an-address");
    const injection = await ask(
      "person@example.com\r\nBcc: attacker@example.com",
    );
    const missing = await ask(undefined);
    await flush();

    for (const response of [bad, injection, missing]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        issues: [{ field: "email", code: "invalid_email" }],
      });
    }
    expect(smtp.sessions).toEqual([]);
  });

  it("refuses a request from another site and one that is not JSON", async () => {
    const { ask, portal, smtp, flush } = await start();

    const crossSite = await ask(PERSON.email, {
      "sec-fetch-site": "cross-site",
    });
    const form = await ask("a=b", {
      "content-type": "application/x-www-form-urlencoded",
    });
    await flush();

    expect(crossSite.status).toBe(403);
    expect(form.status).toBe(415);
    expect(smtp.sessions).toEqual([]);
    expect(portal.adminId).toBeTruthy();
  });

  it("asks again without cancelling the link that is already in the inbox", async () => {
    const { ask, flush, smtp, tokenOf, reset, canSignIn } = await start();
    await ask(PERSON.email);
    await ask(PERSON.email);
    await flush();
    const [first, second] = smtp.messages;

    const done = await reset(tokenOf(first));

    expect(smtp.messages).toHaveLength(2);
    expect(tokenOf(first)).not.toBe(tokenOf(second));
    expect(done.status).toBe(200);
    expect(await canSignIn(PERSON.email, NEW_PASSWORD)).toBe(true);
    // Using one ends the other.
    expect(
      (await reset(tokenOf(second), "an0ther-Passphrase-orbit-77")).status,
    ).toBe(400);
  });
});

describe("the limits of the reset mail", () => {
  // #100-SM-11
  it("refuses the 6th request for one address in an hour with 429, for a known and an unknown address alike", async () => {
    const { ask, flush, smtp } = await start();

    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i <= PASSWORD_RESET_REQUEST_ADDRESS_MAX; i += 1) {
      known.push((await ask(PERSON.email)).status);
      unknown.push((await ask("nobody@example.com")).status);
    }
    await flush();

    expect(known).toEqual([200, 200, 200, 200, 200, 429]);
    expect(unknown).toEqual(known);
    expect(smtp.messages).toHaveLength(PASSWORD_RESET_REQUEST_ADDRESS_MAX);
    const refused = await ask(PERSON.email);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });

  // #100-SM-11
  it("cannot be used up by junk: any number of requests for addresses without an account leave the mail for a real one", async () => {
    const { ask, flush, smtp, rateLimits } = await start();
    for (let i = 0; i < PASSWORD_RESET_MAIL_GLOBAL_MAX + 50; i += 1)
      await ask(`junk-${String(i)}@example.com`);

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    expect(
      (
        await rateLimits.hit(
          PASSWORD_RESET_MAIL_GLOBAL_KEY,
          PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
        )
      ).count,
    ).toBe(2);
  });

  it("stops the instance from sending more reset mails than it allows, without telling anyone apart", async () => {
    const { ask, flush, smtp, rateLimits, logs, portal, advance } =
      await start();
    for (let i = 0; i < PASSWORD_RESET_MAIL_GLOBAL_MAX; i += 1)
      await rateLimits.hit(
        PASSWORD_RESET_MAIL_GLOBAL_KEY,
        PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
      );

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(200);
    expect(smtp.messages).toEqual([]);
    expect(
      await portal.db.selectFrom("password_reset_tokens").selectAll().execute(),
    ).toEqual([]);
    expect(logs.join("\n")).toContain("PASSWORD_RESET_MAIL_LIMITED");
    // After the window the mail goes out again.
    advance(PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS);
    await ask("person@example.com");
    await flush();
    expect(smtp.messages).toHaveLength(1);
  });
});

describe("using the link from the mail", () => {
  async function mailed() {
    const fixture = await start();
    const session = await fixture.portal.signIn(PERSON.email, PERSON.password);
    await fixture.ask(PERSON.email);
    await fixture.flush();
    return {
      ...fixture,
      session,
      token: fixture.tokenOf(fixture.smtp.messages[0]),
    };
  }

  // #100-SM-13
  it("sets the new password, ends the old one and every session of the account", async () => {
    const { reset, token, canSignIn, portal, session } = await mailed();
    const before = await portal.db
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", PERSON.id)
      .execute();

    const response = await reset(token);

    expect(session.size).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    expect(response.status).toBe(200);
    expect(
      await portal.db
        .selectFrom("sessions")
        .select("id")
        .where("user_id", "=", PERSON.id)
        .execute(),
    ).toEqual([]);
    expect(await canSignIn(PERSON.email, NEW_PASSWORD)).toBe(true);
    expect(await canSignIn(PERSON.email, PERSON.password)).toBe(false);
  });

  it("refuses a new password that does not pass the password rule, and the link stays good", async () => {
    const { reset, token, canSignIn } = await mailed();

    const weak = await reset(token, "short");
    const good = await reset(token);

    expect(weak.status).toBe(422);
    expect(good.status).toBe(200);
    expect(await canSignIn(PERSON.email, NEW_PASSWORD)).toBe(true);
  });

  // #100-SM-12
  it("refuses a link that was used, one that expired and one that was changed, with one code", async () => {
    const { reset, token, canSignIn, ask, flush, smtp, advance, tokenOf } =
      await mailed();
    await reset(token);

    const reused = await reset(token);
    await ask(PERSON.email);
    await flush();
    const fresh = tokenOf(smtp.messages[1]);
    const tampered = await reset(
      `${fresh.slice(0, -1)}${fresh.endsWith("A") ? "B" : "A"}`,
    );
    advance(30 * 60 * 1000);
    const expired = await reset(fresh);

    for (const response of [reused, tampered, expired]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_token" });
    }
    expect(await canSignIn(PERSON.email, NEW_PASSWORD)).toBe(true);
    expect(await canSignIn(PERSON.email, "an0ther-Passphrase-orbit-77")).toBe(
      false,
    );
  });

  it("works just before the 30 minutes are over", async () => {
    const { reset, token, advance } = await mailed();

    advance(30 * 60 * 1000 - 1);

    expect((await reset(token)).status).toBe(200);
  });
});

describe("when the mail cannot be sent", () => {
  // #100-SM-09
  it("answers the same, does not crash and writes neither the address nor the link into the log", async () => {
    const { ask, flush, smtp, logs, portal } = await start();
    smtp.behavior.rejectRecipient = "Mailbox unavailable";

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(200);
    expect(smtp.messages).toEqual([]);
    expect(logs.join("\n")).toContain("PASSWORD_RESET_MAIL_FAILED");
    expect(logs.join("\n")).not.toContain(PERSON.email);
    const rows = await portal.db
      .selectFrom("password_reset_tokens")
      .selectAll()
      .execute();
    for (const row of rows)
      expect(logs.join("\n")).not.toContain(row.token_hash);
    expect(logs.join("\n")).not.toContain("reset-password?token");
  });

  it("answers the same when the mail server is down", async () => {
    const { ask, flush, smtp, logs } = await start();
    await smtp.close();

    const response = await ask(PERSON.email);
    await flush();

    expect(response.status).toBe(200);
    expect(logs.join("\n")).toContain("PASSWORD_RESET_MAIL_FAILED");
  });
});
