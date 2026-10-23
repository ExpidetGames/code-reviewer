// SPDX-License-Identifier: Apache-2.0

// The first-run setup, the way an operator does it: read the code from the log of a production build,
// enter it in the browser, answer the three questions, and land in /admin signed in. The app has a
// database of its own that nobody has set up (the third app of the run, see playwright.config.ts).
// The journeys run in order: they share that one instance.
import { expect, test, type Response } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { rawRequest } from "../helpers/raw-request";
import { readSetupCode } from "../helpers/setup";

test.use({ baseURL: e2eEnv.setupAppUrl });

/** The answer to the sign-in form (the server action posts to the login page). */
const submits = (response: Response) =>
  response.request().method() === "POST" &&
  new URL(response.url()).pathname === "/login";

test.describe("the first-run setup", () => {
  test.describe.configure({ mode: "serial" });

  // A reverse proxy or a client can send any `X-Forwarded-Proto`; nothing in front of the app can be
  // told from a client that sends the same. The setup page in place of the page that was asked for
  // must not depend on it: the proxy builds no address, next.config.ts serves the setup page (bug
  // #155). Red before the change (500), green after.
  // #155
  test("a forged X-Forwarded-Proto does not break the setup gate before the setup", async ({
    page,
  }) => {
    const plain = await rawRequest(page, e2eEnv.setupAppUrl, "/");
    expect(plain.status).toBe(200);
    expect(plain.body).toContain("Set up code-review.com");

    for (const forwarded of [
      "https",
      "http",
      "HTTPS",
      "https, http",
      "javascript",
      "",
      "garbage ://",
    ]) {
      const label = JSON.stringify(forwarded);
      const answer = await rawRequest(page, e2eEnv.setupAppUrl, "/", {
        headers: { "x-forwarded-proto": forwarded },
      });
      expect(answer.status, `page ${label}`).toBe(200);
      expect(answer.body, `page ${label}`).toContain("Set up code-review.com");
    }

    // What a reverse proxy (Coolify, Traefik) sends with a request.
    const proxied = await rawRequest(page, e2eEnv.setupAppUrl, "/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "reviewer.example.com",
        "x-forwarded-port": "443",
      },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.body).toContain("Set up code-review.com");

    // An API route answers setup_required, not a 500.
    for (const forwarded of ["https", "garbage ://"]) {
      const label = JSON.stringify(forwarded);
      const answer = await rawRequest(
        page,
        e2eEnv.setupAppUrl,
        "/api/projects",
        { headers: { "x-forwarded-proto": forwarded } },
      );
      expect(answer.status, `api ${label}`).toBe(503);
      expect(answer.body, `api ${label}`).toContain("setup_required");
    }
  });

  // #97-SU-20
  test("@smoke an operator reads the code from the log, walks through the three steps and lands in the admin area signed in", async ({
    page,
  }) => {
    const code = readSetupCode(e2eEnv.logFiles.setup);

    // Any page shows the setup, and the code is nowhere on it.
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Set up code-review.com" }),
    ).toBeVisible();
    expect(await page.content()).not.toContain(code);

    // A wrong code is refused with a sentence, and nothing about it. The form and the input share
    // the accessible name "Setup code", so the input is addressed by its role (#172).
    await page.getByRole("textbox", { name: "Setup code" }).fill("000000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "not correct" }),
    ).toBeVisible();

    // The right one opens the wizard.
    await page.getByRole("textbox", { name: "Setup code" }).fill(code);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "How is this instance used?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.getByRole("heading", { name: "Who may sign up?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /Allowed email domains/ }).click();
    await expect(page.getByText(/nobody except you can sign up/)).toBeVisible();
    await page.getByLabel("Domains", { exact: true }).fill("e2e.test");
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.getByRole("heading", { name: "Create the admin account" }),
    ).toBeVisible();
    await expect(page.getByText(/not a common password/)).toBeVisible();
    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password", { exact: true }).fill("password1234");
    await page.getByLabel("Repeat the password").fill("password1234");
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "too common" }),
    ).toBeVisible();

    await page
      .getByLabel("Password", { exact: true })
      .fill(e2eEnv.adminPassword);
    await page.getByLabel("Repeat the password").fill(e2eEnv.adminPassword);
    await page.getByRole("button", { name: "Finish setup" }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    // Signed in as the address the wizard used: the header menu names the account.
    await page.getByRole("button", { name: "admin", exact: true }).click();
    await expect(page.getByText(e2eEnv.adminEmail)).toBeVisible();

    // The setup is gone: a second visit is a 404, and so is the code form's route.
    const again = await page.goto("/setup");
    expect(again?.status()).toBe(404);
    const codeRoute = await page.request.post("/api/setup/code", {
      data: { code },
    });
    expect(codeRoute.status()).toBe(404);
  });

  // #97-SU-14
  test("after the setup a visitor without a session is sent to the login, and the admin signs in with the email address and the password", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email address")).toBeVisible();

    // A wrong password is refused with the same sentence a wrong email would get.
    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password").fill("not-the-right-password-1");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "not correct" }),
    ).toBeVisible();

    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password").fill(e2eEnv.adminPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  });

  // #97-LIMIT
  test("the login form refuses the sixth attempt for one email address with a sentence about waiting, for an unknown address as for a known one", async ({
    page,
  }) => {
    await page.goto("/login");
    const email = page.getByLabel("Email address");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await email.fill("nobody@e2e.test");
      await page.getByLabel("Password").fill("not-the-right-password-1");
      // The address of the answer is the same for every attempt that fails (`/login?error=invalid_credentials`),
      // and so is the sentence, so neither says that this attempt has landed. The form does: once the
      // server has answered this attempt and the page has taken the answer in, the form is empty again.
      // (Waiting for the address alone let the next attempt start while the last one was still on its way,
      // and the form was cleared under it, so the sixth attempt was never made.)
      const answered = page.waitForResponse(submits);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await answered;
      await expect(email).toHaveValue("");
      await expect(page).toHaveURL(/\/login\?error=/);
    }

    await expect(
      page.getByRole("alert").filter({ hasText: "Too many sign-in attempts" }),
    ).toBeVisible();
  });
});
