// SPDX-License-Identifier: Apache-2.0

// Pins down the mail server settings of the admin portal end to end over a real database, the real proxy and
// the real data routes, with the fake SMTP server as the mail server: what an admin can save, read back and
// send a test mail with, how every failure is told, that a person who is not an admin reaches nothing, and
// that the password is nowhere in an answer, a page or a log line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminHarness } from "../test-support/admin-harness.ts";
import {
  startTestSmtp,
  TEST_SMTP_PASSWORD,
  TEST_SMTP_USER,
} from "../test-support/smtp-fake.ts";
import { TEST_MAIL_ADMIN_MAX } from "../mail/test-mail.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };

async function start() {
  const smtp = await startTestSmtp({
    auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
    authRequiresTls: true,
  });
  const portal = await createAdminHarness();
  const putSmtp = (smtpBody: unknown, cookies = portal.adminCookies) =>
    portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { smtp: smtpBody },
      cookies,
    });
  const valid = (overrides: Record<string, unknown> = {}) => ({
    host: smtp.host,
    port: smtp.port,
    security: "starttls",
    user: TEST_SMTP_USER,
    password: TEST_SMTP_PASSWORD,
    senderAddress: "reviewer@example.com",
    senderName: "Code Reviewer",
    allowSelfSigned: true,
    ...overrides,
  });
  const settings = async () =>
    (await (
      await portal.visit("/api/admin/settings", { cookies: portal.adminCookies })
    ).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the shape is asserted field by field
  const testMail = (cookies = portal.adminCookies) =>
    portal.visit("/api/admin/mail/test", { method: "POST", body: {}, cookies });
  return { smtp, portal, putSmtp, valid, settings, testMail };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving the mail server", () => {
  // #100-SM-01
  it("stores it, and the settings read back say that a password is set and never show it", async () => {
    const { portal, putSmtp, valid, settings } = await start();

    const response = await putSmtp(valid());

    expect(response.status).toBe(200);
    const answer = await response.text();
    expect(answer).not.toContain(TEST_SMTP_PASSWORD);
    const read = await portal.visit("/api/admin/settings", { cookies: portal.adminCookies });
    const text = await read.text();
    expect(text).not.toContain(TEST_SMTP_PASSWORD);
    const body = (await settings()) as { smtp: Record<string, unknown>; mailConfigured: boolean };
    expect(body.smtp).toMatchObject({
      value: {
        host: "127.0.0.1",
        security: "starttls",
        user: TEST_SMTP_USER,
        senderAddress: "reviewer@example.com",
        allowSelfSigned: true,
      },
      password: "configured",
      updatedBy: { id: portal.adminId, email: "admin@example.com" },
    });
    expect(body.mailConfigured).toBe(true);
    // The password column is not the password.
    const row = await portal.db
      .selectFrom("secrets")
      .selectAll()
      .where("name", "=", "smtp_password")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(TEST_SMTP_PASSWORD);
  });

  // #100-SM-02
  it("keeps the password for an empty field and removes it on the explicit clear", async () => {
    const { portal, putSmtp, valid, settings } = await start();
    await putSmtp(valid());

    const kept = await putSmtp(valid({ password: "", senderName: "Reviewer" }));
    const afterKeep = await settings();
    const used = await portal.secrets.use("smtp_password");
    const cleared = await putSmtp(valid({ password: undefined, clearPassword: true }));
    const afterClear = await settings();

    expect(kept.status).toBe(200);
    expect(afterKeep.smtp.password).toBe("configured");
    expect(afterKeep.smtp.value.senderName).toBe("Reviewer");
    expect(used.ok && used.value.reveal()).toBe(TEST_SMTP_PASSWORD);
    expect(cleared.status).toBe(200);
    expect(afterClear.smtp.password).toBe("none");
  });

  // #100-SM-03
  it("refuses each wrong field with its own code and saves nothing", async () => {
    const { putSmtp, valid, settings } = await start();

    const response = await putSmtp(
      valid({ port: 0, host: "", senderAddress: "a@example.com\r\nBcc: x@y.z", senderName: "x\ny" }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; issues: Array<{ field: string; code: string }> };
    expect(body.error).toBe("invalid_input");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        { field: "port", code: "port_invalid" },
        { field: "host", code: "host_required" },
        { field: "senderAddress", code: "sender_invalid" },
        { field: "senderName", code: "sender_name_invalid" },
      ]),
    );
    expect(JSON.stringify(body)).not.toContain(TEST_SMTP_PASSWORD);
    expect((await settings()).smtp.value).toBeNull();
  });

  // #100-SM-07
  it("can be removed at any time, and a sign-up rule that names emails becomes fail-closed again", async () => {
    const { portal, putSmtp, valid, settings } = await start();
    await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { signUp: { kind: "emails", entries: ["someone@example.com"] } },
      cookies: portal.adminCookies,
    });
    await putSmtp(valid());
    const before = await settings();

    const removed = await putSmtp(null);
    const after = await settings();

    expect(before.signUpRuleState).toEqual({ failClosed: false });
    expect(removed.status).toBe(200);
    expect(after.smtp.value).toBeNull();
    expect(after.mailConfigured).toBe(false);
    expect(after.signUpRuleState).toEqual({ failClosed: true });
    expect(await portal.db.selectFrom("secrets").selectAll().execute()).toEqual([]);
  });

  // #100-SM-15
  it("shows a password that cannot be decrypted as unreadable and asks for it again, without failing", async () => {
    const { portal, putSmtp, valid, settings } = await start();
    await putSmtp(valid());
    await portal.db.updateTable("secrets").set({ ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).execute();

    const read = await settings();
    const kept = await putSmtp(valid({ password: "" }));
    const entered = await putSmtp(valid({ password: TEST_SMTP_PASSWORD }));

    expect(read.smtp.password).toBe("unreadable");
    expect(read.mailConfigured).toBe(true);
    expect(kept.status).toBe(422);
    expect(await kept.json()).toMatchObject({ issues: [{ field: "password", code: "password_required" }] });
    expect(entered.status).toBe(200);
    expect((await settings()).smtp.password).toBe("configured");
  });

  it("refuses a request from another site, a body that is not JSON and an oversized body", async () => {
    const { portal, valid } = await start();

    const crossSite = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { smtp: valid() },
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site" },
    });
    const text = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ smtp: valid() }),
      cookies: portal.adminCookies,
      headers: { "content-type": "text/plain" },
    });

    expect(crossSite.status).toBe(403);
    expect(text.status).toBe(415);
  });

  it("writes the password into no log line", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const { putSmtp, valid, testMail } = await start();

    await putSmtp(valid());
    await putSmtp(valid({ port: 0 }));
    await testMail();

    expect(lines.join("\n")).not.toContain(TEST_SMTP_PASSWORD);
  });
});

describe("the test mail", () => {
  // #100-SM-04
  it("sends one message to the admin's own address and the page can say so", async () => {
    const { smtp, putSmtp, valid, testMail } = await start();
    await putSmtp(valid());

    const response = await testMail();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]?.to).toEqual(["admin@example.com"]);
    expect(smtp.messages[0]?.authenticatedAs).toBe(TEST_SMTP_USER);
    expect(smtp.messages[0]?.raw).not.toContain(TEST_SMTP_PASSWORD);
  });

  it("says not_configured when there is no mail server", async () => {
    const { testMail } = await start();

    const response = await testMail();

    expect(await response.json()).toEqual({ ok: false, error: "not_configured", detail: null });
  });

  // #100-SM-05
  it("tells each failure by its class, and the password is in no answer", async () => {
    const { smtp, portal, putSmtp, valid, testMail } = await start();
    const answers: Record<string, unknown> = {};

    // auth_failed
    await putSmtp(valid({ password: "typed-wrong-password-4711" }));
    smtp.behavior.authFailure = "Wrong login typed-wrong-password-4711";
    answers.auth = await (await testMail()).json();
    // tls_error: no certificate trust
    await putSmtp(valid({ allowSelfSigned: false }));
    answers.tls = await (await testMail()).json();
    // sender_rejected
    await putSmtp(valid());
    smtp.behavior.rejectSender = "Sender not allowed";
    answers.sender = await (await testMail()).json();
    // connection_refused
    const closed = await startTestSmtp({ tlsPort: null });
    await closed.close();
    await putSmtp(valid({ port: closed.port }));
    answers.refused = await (await testMail()).json();
    // timeout
    smtp.behavior.rejectSender = null;
    smtp.behavior.greeting = "silent";
    await putSmtp(valid());
    answers.timeout = await (await testMail()).json();

    expect(answers.auth).toMatchObject({ ok: false, error: "auth_failed" });
    expect(answers.tls).toMatchObject({ ok: false, error: "tls_error" });
    expect(answers.sender).toMatchObject({ ok: false, error: "sender_rejected" });
    expect(answers.refused).toMatchObject({ ok: false, error: "connection_refused" });
    expect(answers.timeout).toMatchObject({ ok: false, error: "timeout" });
    const everything = JSON.stringify(answers);
    expect(everything).not.toContain("typed-wrong-password-4711");
    expect(everything).not.toContain(TEST_SMTP_PASSWORD);
    expect(portal.adminId).toBeTruthy();
  });

  it("is limited per admin and says when to try again", async () => {
    const { putSmtp, valid, testMail } = await start();
    await putSmtp(valid());
    for (let index = 0; index < TEST_MAIL_ADMIN_MAX; index += 1)
      expect((await testMail()).status).toBe(200);

    const refused = await testMail();

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers 503 and sends nothing when the counters cannot be read", async () => {
    const { smtp, portal, putSmtp, valid, testMail } = await start();
    await putSmtp(valid());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await portal.db.schema.dropTable("rate_limits").execute();

    const response = await testMail();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(smtp.messages).toEqual([]);
  });

  it("refuses a request from another site and one that is not JSON", async () => {
    const { portal, putSmtp, valid } = await start();
    await putSmtp(valid());

    const crossSite = await portal.visit("/api/admin/mail/test", {
      method: "POST",
      body: {},
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site" },
    });
    const form = await portal.visit("/api/admin/mail/test", {
      method: "POST",
      body: "a=b",
      cookies: portal.adminCookies,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(crossSite.status).toBe(403);
    expect(form.status).toBe(415);
  });
});

describe("a person who is not the admin", () => {
  // #100-SM-06
  it("gets the answer of a missing path from every mail route, and nothing is read or changed", async () => {
    const { smtp, portal, valid, putSmtp } = await start();
    await putSmtp(valid());
    await portal.createUser({ id: "member-1", ...MEMBER });
    const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
    const before = await portal.db.selectFrom("instance_settings").selectAll().execute();

    const read = await portal.visit("/api/admin/settings", { cookies: memberCookies });
    const write = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { smtp: null },
      cookies: memberCookies,
    });
    const test = await portal.visit("/api/admin/mail/test", {
      method: "POST",
      body: {},
      cookies: memberCookies,
    });
    const page = await portal.visit("/admin/mail", { cookies: memberCookies });

    for (const response of [read, write, test, page])
      expect(response.status).toBe(404);
    for (const response of [read, write, test])
      expect(await response.text()).not.toContain("127.0.0.1");
    expect(await portal.db.selectFrom("instance_settings").selectAll().execute()).toEqual(before);
    expect(smtp.messages).toEqual([]);
    expect(smtp.sessions).toEqual([]);
  });

  it("reaches nothing without a session either", async () => {
    const { smtp, portal } = await start();

    const test = await portal.visit("/api/admin/mail/test", { method: "POST", body: {} });

    expect(test.status).toBe(401);
    expect(smtp.sessions).toEqual([]);
  });
});

describe("the admin whose address is not verified", () => {
  // #100-SM-17
  it("still reaches the mail page and the mail routes while a mail server is configured", async () => {
    const { portal, putSmtp, valid, testMail } = await start();
    await putSmtp(valid());
    const verified = await portal.db
      .selectFrom("users")
      .select("email_verified")
      .where("id", "=", portal.adminId)
      .executeTakeFirstOrThrow();

    const page = await portal.visit("/admin/mail", { cookies: portal.adminCookies });
    const data = await portal.visit("/api/admin/settings", { cookies: portal.adminCookies });
    const test = await testMail();

    expect(verified.email_verified).toBe(0);
    expect(page.status).toBe(200);
    expect(data.status).toBe(200);
    expect(test.status).toBe(200);
  });
});
