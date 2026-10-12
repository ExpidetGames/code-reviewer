// SPDX-License-Identifier: Apache-2.0

// Pins down the "send test mail" button: the mail goes to the admin's own address with the saved settings,
// a failure comes back as a stable code with a safe sentence, the button is limited per admin and for the
// instance, and nothing secret is in the mail or in an answer.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  startTestSmtp,
  TEST_SMTP_PASSWORD,
  TEST_SMTP_USER,
} from "../test-support/smtp-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSmtpConfigStore } from "./smtp-config.ts";
import {
  createTestMailService,
  TEST_MAIL_ADMIN_MAX,
  TEST_MAIL_GLOBAL_KEY,
  TEST_MAIL_GLOBAL_MAX,
  testMailAdminKey,
  TEST_MAIL_WINDOW_MS,
} from "./test-mail.ts";

const APP_SECRET = "test-mail-test-secret-0123456789-0123456789";
const QUICK = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};
const ADMIN = { id: "admin-1", email: "admin@example.test" };

async function start(options: { auth?: boolean; configure?: boolean } = {}) {
  const smtp = await startTestSmtp(
    options.auth === false
      ? {}
      : {
          auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
          authRequiresTls: true,
        },
  );
  const { db } = await createTestDatabase();
  for (const id of [
    "admin-1",
    "admin-2",
    "admin-3",
    "admin-4",
    "admin-5",
    "admin-6",
  ])
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${id}, ${`${id}@example.test`}, 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
      db,
    );
  const config = createSmtpConfigStore({ db, appSecret: APP_SECRET });
  const clock = { time: Date.parse("2026-10-12T08:00:00.000Z") };
  const now = () => new Date(clock.time);
  const rateLimits = createRateLimitsRepository(db, now);
  const logs: string[] = [];
  const service = createTestMailService({
    config,
    rateLimits,
    baseUrl: "https://code-reviewer.example.com",
    timeouts: QUICK,
    now,
    log: (line) => logs.push(line),
  });
  if (options.configure !== false)
    await config.save("admin-1", {
      host: smtp.host,
      port: smtp.port,
      security: "starttls",
      allowSelfSigned: true,
      senderAddress: "reviewer@example.com",
      ...(options.auth === false
        ? {}
        : { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD }),
    });
  return { smtp, db, config, service, clock, logs, rateLimits };
}

describe("the test mail", () => {
  // #100-SM-04
  it("sends one message to the admin's address and says so, without any secret in it", async () => {
    const { smtp, service } = await start();

    const result = await service.send(ADMIN);

    expect(result).toEqual({ ok: true });
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.to).toEqual(["admin@example.test"]);
    expect(message?.from).toBe("reviewer@example.com");
    expect(message?.subject).toBe("Test mail from Code Reviewer");
    expect(message?.text).toContain("https://code-reviewer.example.com");
    expect(message?.raw).not.toContain(TEST_SMTP_PASSWORD);
    expect(message?.raw).not.toMatch(/token=/);
  });

  it("answers not_configured when there is no mail server, without connecting anywhere", async () => {
    const { smtp, service } = await start({ configure: false });

    expect(await service.send(ADMIN)).toEqual({
      ok: false,
      error: "not_configured",
      detail: null,
    });
    expect(smtp.sessions).toEqual([]);
  });

  // #100-SM-05
  it("gives the class of the failure with a safe sentence and never the password", async () => {
    const { smtp, service, logs } = await start();
    smtp.behavior.authFailure = `bad login, you sent ${TEST_SMTP_PASSWORD}`;
    await smtp.close();

    const down = await service.send(ADMIN);

    expect(down).toMatchObject({ ok: false, error: "connection_refused" });
    expect(JSON.stringify(down) + logs.join("\n")).not.toContain(
      TEST_SMTP_PASSWORD,
    );
  });

  // #100-SM-05
  it("answers auth_failed with the server's first line and the password left out", async () => {
    const { smtp, service, config } = await start();
    await config.save("admin-1", {
      host: smtp.host,
      port: smtp.port,
      security: "starttls",
      allowSelfSigned: true,
      senderAddress: "reviewer@example.com",
      user: TEST_SMTP_USER,
      password: "typed-wrong-password-4711",
    });
    smtp.behavior.authFailure =
      "Login refused for password typed-wrong-password-4711";

    const result = await service.send(ADMIN);

    expect(result).toMatchObject({ ok: false, error: "auth_failed" });
    expect(JSON.stringify(result)).not.toContain("typed-wrong-password-4711");
    expect(JSON.stringify(result)).toContain("535");
  });

  // #100-SM-15
  it("answers password_unreadable for a password that cannot be decrypted", async () => {
    const { db, smtp, logs } = await start();
    const service = createTestMailService({
      config: createSmtpConfigStore({
        db,
        appSecret: "another-app-secret-0123456789-0123456789-xyz",
      }),
      rateLimits: createRateLimitsRepository(db),
      baseUrl: "https://code-reviewer.example.com",
      timeouts: QUICK,
      log: (line) => logs.push(line),
    });

    expect(await service.send(ADMIN)).toEqual({
      ok: false,
      error: "password_unreadable",
      detail: null,
    });
    expect(smtp.sessions).toEqual([]);
  });

  it("refuses to send to an address that is not deliverable, and says what it is", async () => {
    const { smtp, service } = await start();

    const result = await service.send({
      id: "admin-1",
      email: "not an address\r\nBcc: x@y.z",
    });

    expect(result).toMatchObject({ ok: false, error: "invalid_message" });
    expect(smtp.sessions).toEqual([]);
  });
});

describe("the limit of the test mail", () => {
  it("allows a few per admin in a window, then says when to try again, and sends no more", async () => {
    const { smtp, service, clock } = await start();
    for (let index = 0; index < TEST_MAIL_ADMIN_MAX; index += 1)
      expect(await service.send(ADMIN)).toEqual({ ok: true });

    const refused = await service.send(ADMIN);

    expect(refused).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: TEST_MAIL_WINDOW_MS / 1000,
    });
    expect(smtp.messages).toHaveLength(TEST_MAIL_ADMIN_MAX);

    clock.time += TEST_MAIL_WINDOW_MS;
    expect(await service.send(ADMIN)).toEqual({ ok: true });
  });

  it("counts a failed attempt too", async () => {
    const { smtp, service } = await start();
    smtp.behavior.rejectSender = "no";
    for (let index = 0; index < TEST_MAIL_ADMIN_MAX; index += 1)
      expect(await service.send(ADMIN)).toMatchObject({
        ok: false,
        error: "sender_rejected",
      });

    expect(await service.send(ADMIN)).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("limits the instance as a whole, whoever asks", async () => {
    const { smtp, service } = await start();
    const admins = [
      "admin-1",
      "admin-2",
      "admin-3",
      "admin-4",
      "admin-5",
      "admin-6",
    ];
    let sent = 0;
    for (let round = 0; round < TEST_MAIL_ADMIN_MAX; round += 1)
      for (const id of admins) {
        const result = await service.send({ id, email: `${id}@example.test` });
        if (result.ok) sent += 1;
      }

    expect(sent).toBe(TEST_MAIL_GLOBAL_MAX);
    expect(smtp.messages).toHaveLength(TEST_MAIL_GLOBAL_MAX);
    expect(
      await service.send({ id: "admin-6", email: "admin-6@example.test" }),
    ).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("takes an attempt that the admin's own limit refused back from the instance's budget", async () => {
    const { service } = await start();
    for (let index = 0; index < TEST_MAIL_ADMIN_MAX + 10; index += 1)
      await service.send(ADMIN);

    // 5 mails went out; the 10 refused attempts did not use up the budget of the other admins.
    let others = 0;
    for (const id of ["admin-2", "admin-3", "admin-4"])
      for (let index = 0; index < TEST_MAIL_ADMIN_MAX; index += 1)
        if ((await service.send({ id, email: `${id}@example.test` })).ok)
          others += 1;

    expect(others).toBe(TEST_MAIL_GLOBAL_MAX - TEST_MAIL_ADMIN_MAX);
  });

  it("does not count an attempt against an admin when the instance is out of budget", async () => {
    const { service, rateLimits } = await start();
    for (let index = 0; index < TEST_MAIL_GLOBAL_MAX; index += 1)
      await rateLimits.hit(TEST_MAIL_GLOBAL_KEY, TEST_MAIL_WINDOW_MS);

    const refused = await service.send(ADMIN);
    const counter = await rateLimits.hit(
      testMailAdminKey(ADMIN.id),
      TEST_MAIL_WINDOW_MS,
    );

    expect(refused).toMatchObject({ ok: false, error: "rate_limited" });
    expect(counter.count).toBe(1);
  });

  it("does not count an attempt that finds no mail server against anyone", async () => {
    const { service } = await start({ configure: false });
    for (let index = 0; index < TEST_MAIL_ADMIN_MAX + 3; index += 1)
      expect(await service.send(ADMIN)).toMatchObject({
        error: "not_configured",
      });
  });
});
