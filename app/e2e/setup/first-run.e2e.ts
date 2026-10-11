// The first-run setup, the way an operator does it: read the code from the log of a production build,
// enter it in the browser, answer the three questions, and land in /admin signed in. The app has a
// database of its own that nobody has set up (the third app of the run, see playwright.config.ts).
// The journeys run in order: they share that one instance.
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { readSetupCode } from "../helpers/setup";

test.use({ baseURL: e2eEnv.setupAppUrl });

test.describe("the first-run setup", () => {
  test.describe.configure({ mode: "serial" });

  // #97-SU-20
  test("@smoke an operator reads the code from the log, walks through the three steps and lands in the admin area signed in", async ({
    page,
  }) => {
    const code = readSetupCode(e2eEnv.logFiles.setup);

    // Any page shows the setup, and the code is nowhere on it.
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Set up Code Reviewer" }),
    ).toBeVisible();
    expect(await page.content()).not.toContain(code);

    // A wrong code is refused with a sentence, and nothing about it.
    await page.getByLabel("Setup code").fill("000000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "not correct" }),
    ).toBeVisible();

    // The right one opens the wizard.
    await page.getByLabel("Setup code").fill(code);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "How is this instance used?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.getByRole("heading", { name: "Who may sign up?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /Allowed email domains/ }).check();
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
    await expect(page.getByText(e2eEnv.adminEmail).first()).toBeVisible();

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
    await expect(page).toHaveURL(/\/projects$/);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  });
});
