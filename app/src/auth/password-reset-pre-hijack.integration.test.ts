// SPDX-License-Identifier: Apache-2.0

// Pins down how the reset by mail and the verification links fit together when somebody signs up with
// another person's address first (src/signup/pre-hijack.integration.test.ts has the sign-up side). Everything
// goes through the real SMTP sender and the fake SMTP server: the mails land in the owner's inbox, as they do
// in production, and the attacker never sees one. The owner resets the password; whatever the attacker chose
// and every link of the attacker's sign-up stop counting, and nothing the owner does afterwards hands the
// account back.
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createSmtpMailSender } from "../mail/smtp-sender.ts";
import { assembleSignUp } from "../signup/assemble.ts";
import { createSignUpLimits } from "../signup/limits.ts";
import {
  ADMIN_TEST_BASE_URL,
  createAdminHarness,
} from "../test-support/admin-harness.ts";
import { startTestSmtp } from "../test-support/smtp-fake.ts";
import { completePasswordReset, isKnownResetToken } from "./password-reset.ts";
import { createPasswordResetHandler } from "./password-reset-http.ts";
import { requestPasswordReset } from "./password-reset-request.ts";

const QUICK = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};
const VICTIM = "victim@example.com";
const ATTACKER_PASSWORD = "attacker-chosen-pw-4417";
const OWNER_PASSWORD = "owner-chosen-passphrase-9051";

async function start() {
  const portal = await createAdminHarness();
  const smtp = await startTestSmtp({ tlsPort: null });
  await portal.smtp.save(portal.adminId, {
    host: smtp.host,
    port: smtp.port,
    security: "starttls",
    allowSelfSigned: true,
    senderAddress: "reviewer@example.com",
  });
  // As in production with a mail server: an unverified address does not sign in.
  portal.flags.mail = true;
  const mail = createSmtpMailSender({
    config: portal.smtp,
    timeouts: QUICK,
    log: () => undefined,
  });
  const context = await portal.auth.$context;
  const pending: Array<() => Promise<void>> = [];
  const now = () => new Date();
  const rateLimits = createRateLimitsRepository(portal.db, now);
  const limits = createSignUpLimits(rateLimits, now);

  const signup = assembleSignUp({
    db: portal.db,
    mail,
    hashPassword: context.password.hash,
    verifyPassword: context.password.verify,
    githubConfigured: () => false,
    baseUrl: ADMIN_TEST_BASE_URL,
    currentUserId: () => Promise.resolve(null),
    defer: (work) => {
      pending.push(() => work);
    },
    log: () => undefined,
  });
  const resetComplete = createPasswordResetHandler({
    rateLimits,
    isKnownToken: (token) => isKnownResetToken(portal.db, token),
    complete: (input) =>
      completePasswordReset(
        { db: portal.db, hashPassword: context.password.hash },
        input,
      ),
  });

  const post = (path: string, body: unknown) =>
    new Request(`${ADMIN_TEST_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const flush = async () => {
    await Promise.all(pending.splice(0).map((work) => work()));
  };

  const tokenOf = (subject: string, which: "first" | "last" = "last") => {
    const messages = smtp
      .to(VICTIM)
      .filter((message) => message.subject === subject);
    const message = which === "first" ? messages[0] : messages.at(-1);
    const link = /https?:\/\/\S+/.exec(message?.text ?? "")?.[0] ?? "";
    return new URL(link).searchParams.get("token") ?? "";
  };

  return {
    portal,
    smtp,
    flush,
    signUp: async (password: string) => {
      const response = await signup.signUp(
        post("/api/sign-up", { email: VICTIM, password }),
      );
      await flush();
      return response;
    },
    verify: (token: string, password?: string) =>
      signup.verify(post("/api/verify-email", { token, password })),
    resend: async () => {
      const response = await signup.resend(
        post("/api/verify-email/resend", { email: VICTIM }),
      );
      await flush();
      return response;
    },
    askForReset: async () => {
      await requestPasswordReset(
        {
          db: portal.db,
          mail,
          limits,
          emailPasswordOn: () => Promise.resolve(true),
          baseUrl: ADMIN_TEST_BASE_URL,
          defer: (work) => {
            pending.push(work);
          },
        },
        VICTIM,
      );
      await flush();
    },
    reset: (token: string, password: string) =>
      resetComplete(post("/api/password-reset", { token, password })),
    tokenOf,
    async accountPasswordIs(password: string) {
      const row = await portal.db
        .selectFrom("accounts")
        .innerJoin("users", "users.id", "accounts.user_id")
        .select(["accounts.password"])
        .where("users.email", "=", VICTIM)
        .where("accounts.provider_id", "=", "credential")
        .executeTakeFirstOrThrow();
      return context.password.verify({ hash: row.password ?? "", password });
    },
    async verified() {
      const row = await portal.db
        .selectFrom("users")
        .select("email_verified")
        .where("email", "=", VICTIM)
        .executeTakeFirstOrThrow();
      return row.email_verified === 1;
    },
    canSignIn: (password: string) =>
      portal.auth.api.signInEmail({ body: { email: VICTIM, password } }).then(
        () => true,
        () => false,
      ),
  };
}

describe("the reset by mail for an address somebody else signed up with first", () => {
  // #100-review-10
  it("gives the account to the owner: the attacker's password and every link of the attacker's sign-up are dead", async () => {
    const app = await start();
    await app.signUp(ATTACKER_PASSWORD);
    const attackersLink = app.tokenOf("Confirm your email address");
    await app.askForReset();

    const resetDone = await app.reset(
      app.tokenOf("Reset your password"),
      OWNER_PASSWORD,
    );
    const withAttackersPassword = await app.verify(
      attackersLink,
      ATTACKER_PASSWORD,
    );
    const withOwnersPassword = await app.verify(attackersLink, OWNER_PASSWORD);

    expect(resetDone.status).toBe(200);
    expect(withAttackersPassword.status).toBe(400);
    expect(await withAttackersPassword.json()).toEqual({
      error: "invalid_token",
    });
    expect(withOwnersPassword.status).toBe(400);
    expect(await app.accountPasswordIs(OWNER_PASSWORD)).toBe(true);
    expect(await app.accountPasswordIs(ATTACKER_PASSWORD)).toBe(false);
    expect(await app.verified()).toBe(false);
    expect(await app.canSignIn(ATTACKER_PASSWORD)).toBe(false);
  });

  // #100-review-10
  it("does not verify the address by itself; the owner confirms it with a link made for the new password", async () => {
    const app = await start();
    await app.signUp(ATTACKER_PASSWORD);
    await app.askForReset();
    await app.reset(app.tokenOf("Reset your password"), OWNER_PASSWORD);

    // A reset link proves nothing the verification does not: the address is still unconfirmed.
    expect(await app.verified()).toBe(false);
    expect(await app.canSignIn(OWNER_PASSWORD)).toBe(false);
    await app.resend();
    const ownersLink = app.tokenOf("Confirm your email address");
    const attacker = await app.verify(ownersLink, ATTACKER_PASSWORD);
    const owner = await app.verify(ownersLink, OWNER_PASSWORD);

    expect(attacker.status).toBe(400);
    expect(owner.status).toBe(200);
    expect(await app.verified()).toBe(true);
    expect(await app.canSignIn(OWNER_PASSWORD)).toBe(true);
    expect(await app.canSignIn(ATTACKER_PASSWORD)).toBe(false);
  });

  // #100-review-10
  it("is not undone by another sign-up of the attacker: the account's password stays the owner's, and the reset link made before still works", async () => {
    const app = await start();
    await app.signUp(ATTACKER_PASSWORD);
    await app.askForReset();
    const resetToken = app.tokenOf("Reset your password");

    // The attacker signs up again after the reset mail went out.
    await app.signUp("attacker-second-try-pw-7731");
    const stillTheFirst = await app.accountPasswordIs(ATTACKER_PASSWORD);
    const reset = await app.reset(resetToken, OWNER_PASSWORD);

    expect(stillTheFirst).toBe(true);
    expect(reset.status).toBe(200);
    expect(await app.accountPasswordIs(OWNER_PASSWORD)).toBe(true);
    // The links of both sign-ups are gone with the reset.
    for (const which of ["first", "last"] as const) {
      const link = app.tokenOf("Confirm your email address", which);
      for (const password of [
        ATTACKER_PASSWORD,
        "attacker-second-try-pw-7731",
        OWNER_PASSWORD,
      ])
        expect((await app.verify(link, password)).status).toBe(400);
    }
    expect(await app.verified()).toBe(false);
  });

  // #100-review-10
  it("sends the attacker nothing: a reset asked for by anybody goes to the inbox of the address only", async () => {
    const app = await start();
    await app.signUp(ATTACKER_PASSWORD);

    await app.askForReset();

    expect(
      app.smtp.messages.every((message) => message.to.join() === VICTIM),
    ).toBe(true);
    // And the link is of no use without the mail: a made-up token does nothing.
    const guess = await app.reset("A".repeat(43), "attacker-wants-in-pw-1234");
    expect(guess.status).toBe(400);
    expect(await app.accountPasswordIs(ATTACKER_PASSWORD)).toBe(true);
  });
});
