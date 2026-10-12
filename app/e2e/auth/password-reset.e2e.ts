// SPDX-License-Identifier: Apache-2.0

// Resetting a forgotten password by mail in a real browser against a production build and the fake SMTP
// server: a person with an account asks for a link on the login page, reads it in their inbox, chooses a new
// password and signs in with it (the old one is dead); an address without an account gets the same words and
// no mail. The app is the fourth one, with the mail server the journey of the mail page configured. The rules
// behind are proven as integration tests (src/auth/password-reset-request.integration.test.ts).
import {
  expect,
  request as playwrightRequest,
  test,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { e2eEnv } from "../helpers/e2e-env";
import { messageTo, readInbox, verificationLinkTo } from "../helpers/mail";

// An address of its own for every worker process: a worker that is started again (after a failure or on a
// retry) signs up a new account and does not meet the confirmed one of its predecessor.
const ADDRESS = `forgetful-${randomUUID().slice(0, 8)}@e2e.test`;
const OLD_PASSWORD = "e2e-forgetful-passphrase-old-41";
const NEW_PASSWORD = "e2e-forgetful-passphrase-new-93";
const ANSWER =
  "Check your inbox. If this address has an account that signs in with a password, we sent it a link to choose a new password. The link works once and for 30 minutes.";

async function signInThroughTheForm(
  page: Page,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(ADDRESS);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function askForALink(page: Page, address: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  // (Next.js keeps the page the visitor came from in the document, hidden, so labels are looked up inside the
  // form.)
  const form = page.getByRole("form", { name: "Request a reset link" });
  await form.getByLabel("Email address").fill(address);
  await form.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByRole("status")).toHaveText(ANSWER);
}

test.describe("resetting a password by mail", () => {
  // The account of the journey: signed up and confirmed, as a person does it (through the routes of the pages).
  test.beforeAll(async () => {
    const client = await playwrightRequest.newContext({
      baseURL: e2eEnv.signupAppUrl,
    });
    try {
      const created = await client.post("/api/sign-up", {
        data: { email: ADDRESS, password: OLD_PASSWORD },
      });
      expect(created.status(), await created.text()).toBe(200);
      const token = new URL(await verificationLinkTo(ADDRESS)).searchParams.get(
        "token",
      );
      const verified = await client.post("/api/verify-email", {
        data: { token, password: OLD_PASSWORD },
      });
      expect(verified.status(), await verified.text()).toBe(200);
    } finally {
      await client.dispose();
    }
  });

  // #100-SM-10, #100-SM-13
  test("a person who forgot the password asks for a link, chooses a new password from the mail and signs in with it", async ({
    page,
  }) => {
    await askForALink(page, ADDRESS);

    const message = await messageTo(ADDRESS, "Reset your password");
    const link = /https?:\/\/\S+/.exec(message.text)?.[0] ?? "";
    expect(link).toContain(`${e2eEnv.signupAppUrl}/reset-password?token=`);
    expect(message.text).toContain("30 minutes");

    await page.goto(link);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Repeat the password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set the password" }).click();
    await expect(page.getByRole("status")).toContainText(
      "The password was changed",
    );

    // The old password is dead, the new one signs in.
    await signInThroughTheForm(page, OLD_PASSWORD);
    await expect(page).toHaveURL(/\/login\?error=invalid_credentials$/);
    await signInThroughTheForm(page, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/no-access$/);

    // The link works once.
    await page
      .getByRole("button", { name: ADDRESS.split("@")[0] ?? "" })
      .click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.goto(link);
    await page
      .getByLabel("New password")
      .fill("e2e-forgetful-passphrase-third-17");
    await page
      .getByLabel("Repeat the password")
      .fill("e2e-forgetful-passphrase-third-17");
    await page.getByRole("button", { name: "Set the password" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "not valid any more" }),
    ).toBeVisible();
  });

  // #100-SM-11
  test("an address without an account gets the same words and no mail", async ({
    page,
  }) => {
    const stranger = "stranger-nobody@e2e.test";
    await askForALink(page, stranger);

    // Asking for a known address after it: by the time that mail is in the inbox, the stranger's would be
    // too, if there were one.
    await askForALink(page, ADDRESS);
    await messageTo(ADDRESS, "Reset your password");

    expect(await readInbox(stranger)).toEqual([]);
  });
});
