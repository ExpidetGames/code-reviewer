// SPDX-License-Identifier: Apache-2.0

// The mail page in a real browser against a production build and the fake SMTP server: the admin of an
// instance without a mail server finds no "forgot your password" option, configures the mail server in the
// portal (host, port, STARTTLS, login, sender), sends a test mail that arrives in the fake's inbox, reads in
// words why it fails when the password is wrong or nothing listens, and the password is never shown again.
// The rules behind are proven as integration tests (src/mail/, src/admin/mail.integration.test.ts). The app
// is the fourth one; this journey leaves it with a working mail server for the sign-up and the password
// reset journeys, which depend on it.
import { expect, test, type Page } from "@playwright/test";
import {
  configureFakeMailServer,
  removeMailServer,
} from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import { messageTo, readInbox } from "../helpers/mail";

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // With a mail server the admin's unverified address sends them to the verification page.
  await page.waitForURL(/\/(w\/default\/projects|verify-email)$/);
}

const form = (page: Page) =>
  page.getByRole("form", { name: "Mail server (SMTP)" });

const testMailCard = (page: Page) =>
  page.getByRole("region", { name: "Test mail" });

async function fillServer(
  page: Page,
  values: { port?: number; password?: string } = {},
): Promise<void> {
  const mail = form(page);
  await mail.getByLabel("Host", { exact: true }).fill(e2eEnv.smtp.host);
  await mail
    .getByLabel("Port", { exact: true })
    .fill(String(values.port ?? e2eEnv.smtp.port));
  await mail.getByRole("radio", { name: /^STARTTLS/ }).check();
  await mail
    .getByRole("checkbox", { name: "Accept a self-signed certificate" })
    .check();
  await mail.getByLabel("User", { exact: true }).fill(e2eEnv.smtp.user);
  if (values.password !== undefined)
    await mail.getByLabel("Password", { exact: true }).fill(values.password);
  await mail
    .getByLabel("Sender address", { exact: true })
    .fill("code-reviewer@e2e.test");
  await mail
    .getByLabel("Sender name (optional)", { exact: true })
    .fill("Code Reviewer");
}

async function save(page: Page): Promise<void> {
  await form(page).getByRole("button", { name: "Save mail server" }).click();
  await expect(
    form(page).getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible();
}

async function sendTestMail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Send test mail" }).click();
}

test.describe("the mail page", () => {
  // Every attempt starts from an app without a mail server, also a retry.
  test.beforeAll(async () => {
    await removeMailServer(e2eEnv.signupAppUrl);
  });

  // The journeys after this one need a working mail server, whatever happened here.
  test.afterAll(async () => {
    await configureFakeMailServer(e2eEnv.signupAppUrl);
  });

  // #100-SM-14
  test("without a mail server the login page offers no way to reset a password and the page for it does not exist", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Forgot your password?" }),
    ).toHaveCount(0);

    const route = await page.request.post("/api/password-reset/request", {
      data: { email: "someone@e2e.test" },
    });
    await page.goto("/forgot-password");

    expect(route.status()).toBe(404);
    // The page decides at request time, behind a boundary, so it shows the page that is not found (the
    // status of the answer is already 200 by then); there is no form.
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send me a link" }),
    ).toHaveCount(0);
  });

  // #100-SM-16
  test("@smoke the admin configures the mail server in the portal, sends a test mail and finds it in the inbox", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/mail");
    await expect(
      page.getByRole("heading", { level: 1, name: "Mail" }),
    ).toBeVisible();
    // The page below the Admin overview shows its trail (#184, breadcrumb rule of #179).
    const crumb = page.getByRole("navigation", { name: "breadcrumb" });
    await expect(crumb.getByRole("link", { name: "Admin" })).toBeVisible();
    await expect(crumb.getByRole("link", { name: "Mail" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("button", { name: "Send test mail" }),
    ).toBeDisabled();

    await fillServer(page, { password: e2eEnv.smtp.password });
    await save(page);

    // The password is saved and never shown again; the form says so and the field is empty.
    await page.reload();
    await expect(form(page).getByText(/A password is saved/)).toBeVisible();
    await expect(
      form(page).getByLabel("Password", { exact: true }),
    ).toHaveValue("");
    await expect(form(page).getByLabel("Host", { exact: true })).toHaveValue(
      e2eEnv.smtp.host,
    );
    expect(await page.content()).not.toContain(e2eEnv.smtp.password);

    await sendTestMail(page);
    await expect(page.getByText(/handed to the mail server/)).toBeVisible();

    const message = await messageTo(
      e2eEnv.adminEmail,
      "Test mail from Code Reviewer",
    );
    expect(message.from).toBe("code-reviewer@e2e.test");
    expect(message.secure).toBe(true);
    expect(message.authenticatedAs).toBe(e2eEnv.smtp.user);
    expect(message.text).toContain(e2eEnv.signupAppUrl);
    expect(message.text).not.toContain(e2eEnv.smtp.password);
  });

  // #100-SM-05
  test("a wrong password and a port nobody listens on are told in words, and the password is not on the page", async ({
    page,
  }) => {
    const wrong = "e2e-wrong-smtp-password-9981";
    await signInAsAdmin(page);
    await page.goto("/admin/mail");

    await form(page).getByLabel("Password", { exact: true }).fill(wrong);
    await save(page);
    await sendTestMail(page);
    await expect(
      testMailCard(page)
        .getByRole("status")
        .filter({ hasText: "refused the login" }),
    ).toBeVisible();
    await expect(
      testMailCard(page).getByRole("status").filter({ hasText: "535" }),
    ).toBeVisible();
    expect(await page.content()).not.toContain(wrong);

    await fillServer(page, {
      port: e2eEnv.smtp.controlPort + 1,
      password: e2eEnv.smtp.password,
    });
    await save(page);
    await sendTestMail(page);
    await expect(
      testMailCard(page)
        .getByRole("status")
        .filter({ hasText: "Nothing answered on that host and port" }),
    ).toBeVisible();

    // Back to a working server: the test mail arrives again.
    await fillServer(page, { password: e2eEnv.smtp.password });
    await save(page);
    await sendTestMail(page);
    await expect(page.getByText(/handed to the mail server/)).toBeVisible();
    expect((await readInbox(e2eEnv.adminEmail)).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  // #100-SM-01
  test("the settings route never returns the password, and a person who is not signed in gets nothing", async ({
    page,
    request,
  }) => {
    await signInAsAdmin(page);

    const settings = await page.request.get("/api/admin/settings");
    const body = await settings.text();

    expect(settings.status()).toBe(200);
    expect(body).not.toContain(e2eEnv.smtp.password);
    expect(JSON.parse(body)).toMatchObject({
      smtp: { password: "configured" },
    });
    expect((await request.get("/api/admin/settings")).status()).toBe(401);
    expect(
      (await request.post("/api/admin/mail/test", { data: {} })).status(),
    ).toBe(401);
  });
});
