// Helpers for the journeys that sign in: add an account to the fake GitHub that Playwright started
// next to the app, and walk through the sign in form the way a person does.
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

export type GithubAccount = {
  id: number;
  login: string;
  name: string;
  email: string | null;
};

/** Each spec file owns its accounts (own id and login); nobody resets the fake while others run. */
export async function addGithubAccount(
  request: APIRequestContext,
  account: GithubAccount,
): Promise<void> {
  const response = await request.post(`${e2eEnv.githubUrl}/__fake/users`, {
    data: account,
  });
  expect(response.status()).toBe(201);
}

/** Opens the app, signs in as `account` at the fake GitHub and waits for the signed in page. */
export async function signInThroughTheForm(
  page: Page,
  account: GithubAccount,
): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page
    .getByRole("button", { name: `Authorize ${account.login}` })
    .click();
  await expect(page.getByText(`Signed in as ${account.name}`)).toBeVisible();
}
