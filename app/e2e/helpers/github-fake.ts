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

/** Opens the app, signs in as `account` at the fake GitHub and waits for the signed in app (the user menu with their name). */
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
  await expect(userMenuButton(page, account)).toBeVisible();
}

/** The button of the user menu in the header, named after the person. */
export function userMenuButton(page: Page, account: GithubAccount) {
  return page.getByRole("button", { name: account.name });
}

/** Opens the user menu and presses "Sign out". */
export async function signOutThroughTheMenu(
  page: Page,
  account: GithubAccount,
): Promise<void> {
  await userMenuButton(page, account).click();
  await page.getByRole("button", { name: "Sign out" }).click();
}

export type GithubInstallation = {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
};

/**
 * Installs the GitHub App for an account at the fake, with these repositories (replacing the ones
 * of an installation that exists). Each spec file owns its installations, like its accounts. The app
 * learns about them at its next sync (the "Sync from GitHub" button).
 */
export async function addGithubInstallation(
  request: APIRequestContext,
  installation: GithubInstallation,
  repositories: Array<{ id: number; fullName: string }>,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/installations`,
    { data: { installation, repositories } },
  );
  expect(response.status()).toBe(201);
}
