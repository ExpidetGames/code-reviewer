// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the two journeys that make the app usable: signing in with GitHub (against the fake
// GitHub, as a person does through the form) and signing out again. Every other behavior of the
// sign in is proven at a lower level.
import { expect, test } from "@playwright/test";
import {
  addGithubAccount,
  signInThroughTheForm,
  signOutThroughTheMenu,
  userMenuButton,
  type GithubAccount,
} from "../helpers/github-fake";
import { landingIdentityOf } from "../helpers/landing-identity";

const account: GithubAccount = {
  id: 7100001,
  login: "login-journey",
  name: "Login Journey",
  email: "login-journey@example.test",
};

// A GitHub account no app knows yet: its first sign in makes the user.
const visitor: GithubAccount = {
  id: 7100002,
  login: "landing-visitor",
  name: "Landing Visitor",
  email: "landing-visitor@example.test",
};

test.describe("signing in and out", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubAccount(request, visitor, null);
  });

  // CR-18-T01
  test("@smoke a person signs in with GitHub, sees their name and stays signed in after a reload", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    await expect(page).toHaveURL(/\/w\/default\/projects$/);
    await expect(userMenuButton(page, account)).toBeVisible();

    await page.reload();

    await expect(userMenuButton(page, account)).toBeVisible();
  });

  // #102-GH-26
  test("an imported user's placeholder address is replaced by the verified address of the GitHub account at the first sign in", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    await page.goto("/account");

    await expect(
      page.getByRole("heading", { level: 1, name: "Account" }),
    ).toBeVisible();
    await expect(page.getByText(account.email ?? "")).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByText(`@${account.login}`)).toBeVisible();
  });

  // #692-T04
  test("a visitor who comes from the landing page keeps the PostHog identity on the account that GitHub creates", async ({
    page,
  }) => {
    const distinctId = "0192f5f0-7c3e-7a52-9d1b-3f6a2c4e8b10";
    const sessionId = "0192f5f0-7c3e-7a52-9d1b-bbbbbbbbbbbb";

    await page.goto(`/login?ph_did=${distinctId}&ph_sid=${sessionId}`);
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page
      .getByRole("button", { name: `Authorize ${visitor.login}` })
      .click();

    // A new account has no workspace yet.
    await expect(page).toHaveURL(/\/no-access$/);
    expect(await landingIdentityOf(visitor.email ?? "", "main")).toMatchObject({
      distinctId,
      sessionId,
    });
  });

  // CR-18-T02
  test("a signed in person signs out, lands on the login page and is sent back there from a protected page", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    await signOutThroughTheMenu(page, account);

    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeVisible();
  });
});
