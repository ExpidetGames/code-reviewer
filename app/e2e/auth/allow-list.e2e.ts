// SPDX-License-Identifier: Apache-2.0

// Pins down the journey of a person whose GitHub account is not on the allow list: they authorize
// at GitHub, land back on the login page with a clear message, and are still signed out afterwards.
// Which accounts are allowed (case, whitespace, organization, re-checks) is proven at a lower level.
import { expect, test } from "@playwright/test";
import { addGithubAccount, type GithubAccount } from "../helpers/github-fake";

const stranger: GithubAccount = {
  id: 7200001,
  login: "stranger-journey",
  name: "Stranger Journey",
  email: "stranger-journey@example.test",
};

test.describe("an account that is not allowed", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, stranger);
  });

  // CR-19-T07
  test("a person with a GitHub account that is not allowed sees the message on the login page and stays signed out", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();

    await page
      .getByRole("button", { name: `Authorize ${stranger.login}` })
      .click();

    await expect(page).toHaveURL(/\/login\?error=not_allowed(&|$)/);
    await expect(
      page.getByText(
        "Your GitHub account is not allowed to use this Code Reviewer instance.",
      ),
    ).toBeVisible();
    await expect(page.getByText(stranger.name)).toHaveCount(0);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});
