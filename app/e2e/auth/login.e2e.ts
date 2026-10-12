// SPDX-License-Identifier: Apache-2.0

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

const account: GithubAccount = {
  id: 7100001,
  login: "login-journey",
  name: "Login Journey",
  email: "login-journey@example.test",
};

test.describe("signing in and out", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
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
