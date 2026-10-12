// SPDX-License-Identifier: Apache-2.0

// The GitHub integration of the admin portal, the way an operator meets it, against the fake GitHub: the App
// is created with one click (the manifest flow), people sign in with it (the sign-up rule is applied to their
// verified address), the admin links the GitHub account of an imported operator and the two accounts become
// one, GitHub becomes the only way to sign in, and the App is entered by hand. The journeys run in order:
// they share the third app of the run, which the first-run journey has set up (see playwright.config.ts).
import { expect, test, type Page } from "@playwright/test";
import { changeAdminSetting } from "../helpers/admin-api";
import { e2eEnv, githubAppPrivateKey } from "../helpers/e2e-env";
import { addGithubAccount, type GithubAccount } from "../helpers/github-fake";

test.use({ baseURL: e2eEnv.setupAppUrl });

const newcomer: GithubAccount = {
  id: 7600001,
  login: "gh-newcomer",
  name: "Gh Newcomer",
  email: "newcomer@e2e.test",
};
const unverified: GithubAccount = {
  id: 7600002,
  login: "gh-unverified",
  name: "Gh Unverified",
  email: null,
  emails: [{ email: "unverified@e2e.test", primary: true, verified: false }],
};
const operator: GithubAccount = {
  id: 7600003,
  login: "gh-operator",
  name: "Gh Operator",
  email: "operator@e2e.test",
};

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** Starts at the login page and signs in with GitHub as the account; the page after it is the caller's to judge. */
async function signInWithGithub(
  page: Page,
  account: GithubAccount,
): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page
    .getByRole("button", { name: `Authorize ${account.login}` })
    .click();
}

test.describe("the GitHub integration of the admin portal", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, newcomer, null);
    await addGithubAccount(request, unverified, null);
    // The operator of an installation that ran before accounts existed: an imported user, a member.
    await addGithubAccount(request, operator, "setup", "member");
  });

  // #102-GH-19
  test("@smoke the admin creates the GitHub App with one click and the tile shows it configured", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/integrations");
    await expect(page.getByRole("heading", { name: /^GitHub/ })).toContainText(
      "Not configured",
    );

    await page.getByRole("button", { name: "Create GitHub App" }).click();
    // GitHub's page: the person confirms there.
    await expect(
      page.getByRole("heading", { name: "Register new GitHub App" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create GitHub App" }).click();

    await expect(page).toHaveURL(/\/admin\/integrations\?github=created$/);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "The GitHub App was created" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /^GitHub/ })).toContainText(
      "Configured",
    );
    await expect(page.getByText("Created from this page.")).toBeVisible();
    // The manifest asks for the user authorization too, so signing in with GitHub is enabled.
    await expect(page.getByText("Enabled.", { exact: true })).toBeVisible();
    // No secret reaches the page.
    expect(await page.content()).not.toContain("PRIVATE KEY");
    // The sign in with GitHub is on the login page now.
    await page.context().clearCookies();
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeVisible();
  });

  // #102-GH-11
  test("a person signs in with GitHub: the sign-up rule is applied to their verified address, and an account nobody invited waits for an invitation", async ({
    page,
  }) => {
    // The rule the first-run journey chose names a domain, and nothing can verify addresses yet.
    await signInWithGithub(page, newcomer);
    await expect(page).toHaveURL(/\/login\?error=signup_closed/);
    await expect(page.getByText("Signing up is closed")).toBeVisible();

    // Everyone may sign up now; a GitHub account without a verified primary address still may not.
    await changeAdminSetting(e2eEnv.setupAppUrl, {
      signUp: { kind: "everyone" },
    });
    await signInWithGithub(page, unverified);
    await expect(page).toHaveURL(/\/login\?error=github_email_unverified/);
    await expect(page.getByText(/no verified primary email/)).toBeVisible();

    await signInWithGithub(page, newcomer);
    await expect(page).toHaveURL(/\/no-access$/);
    await expect(
      page.getByRole("heading", { name: "No workspace yet" }),
    ).toBeVisible();
  });

  // #102-GH-23
  test("the admin links the GitHub account of an imported operator and the two accounts become one, so GitHub can become the only way to sign in", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/integrations");
    await expect(page.getByText("Not linked.")).toBeVisible();

    await page.getByRole("button", { name: "Link GitHub account" }).click();
    await page
      .getByRole("button", { name: `Authorize ${operator.login}` })
      .click();

    await expect(page).toHaveURL(/\/admin\/integrations\?github=merged$/);
    await expect(
      page.getByRole("status").filter({ hasText: "merged into this one" }),
    ).toBeVisible();
    await expect(page.getByText(`@${operator.login}`)).toBeVisible();

    // Now GitHub can be the only way to sign in.
    await page.goto("/admin/setup");
    await page.getByRole("checkbox", { name: /Email with password/ }).uncheck();
    await page.getByRole("button", { name: "Save ways to sign in" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }).last(),
    ).toBeVisible();

    // The login page offers GitHub only, and the operator's GitHub account is the admin.
    await page.context().clearCookies();
    await page.goto("/login");
    await expect(page.getByLabel("Email address")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page
      .getByRole("button", { name: `Authorize ${operator.login}` })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.getByRole("button", { name: operator.name }).click();
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  });

  // #102-GH-05
  test("the admin enters the App by hand: a wrong value is named at its field and nothing is saved, then the values are checked against GitHub and saved", async ({
    page,
  }) => {
    await signInWithGithub(page, operator);
    await expect(page).toHaveURL(/\/projects$/);
    await page.goto("/admin/integrations");
    const form = page.getByRole("form", { name: "Enter the values by hand" });

    await form.getByLabel("App ID").fill(e2eEnv.githubAppId);
    await form.getByLabel("Slug").fill("another-slug");
    await form.getByLabel("Private key").fill(githubAppPrivateKey());
    await form.getByLabel("Webhook secret").fill(e2eEnv.githubAppWebhookSecret);
    await form.getByLabel("Client ID").fill(e2eEnv.githubClientId);
    await form.getByLabel("Client secret").fill(e2eEnv.githubClientSecret);
    // There is no default for the App's visibility: the choice is required (this instance has an answer from
    // the App that is configured, so one is shown; an App without an answer starts with none).
    await expect(form.getByLabel(/Only on its own account/)).toHaveAttribute(
      "required",
      "",
    );
    await form.getByLabel(/Only on its own account/).check();
    await form.getByRole("button", { name: "Save and check" }).click();
    await expect(form.getByText("another slug")).toBeVisible();

    await form.getByLabel("Slug").fill(e2eEnv.githubAppSlug);
    await form.getByRole("button", { name: "Save and check" }).click();
    await expect(
      form.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await expect(page.getByText(e2eEnv.githubAppSlug).first()).toBeVisible();
    // The secrets were sent once; the page forgot them and says that they are saved.
    await expect(form.getByLabel("Private key")).toHaveValue("");
    await expect(form.getByText("A value is saved").first()).toBeVisible();
    expect(await page.content()).not.toContain(e2eEnv.githubClientSecret);
    expect(await page.content()).not.toContain("PRIVATE KEY");

    // The new credentials sign people in.
    await page.context().clearCookies();
    await signInWithGithub(page, operator);
    await expect(page).toHaveURL(/\/projects$/);
  });
});
