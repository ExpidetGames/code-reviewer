// SPDX-License-Identifier: Apache-2.0

// Helpers for the journeys that sign in: add an account to the fake GitHub that Playwright started
// next to the app, and walk through the sign in form the way a person does.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

const run = promisify(execFile);
const ACCOUNTS_CHILD = resolve(
  process.cwd(),
  "src/test-support/e2e-accounts-child.ts",
);

export type GithubAccount = {
  id: number;
  login: string;
  name: string;
  /** The public profile email. Also the one verified primary address, unless `emails` says otherwise. */
  email: string | null;
  /** What `GET /user/emails` answers, when it should not be just the public email. */
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
};

/** The apps a journey can sign an account into: the SQLite file of each. */
export type AppUnderTest = "main" | "pipeline" | "setup";
const DATABASES: Record<AppUnderTest, string> = {
  main: e2eEnv.databasePath,
  pipeline: e2eEnv.pipelineDatabasePath,
  setup: e2eEnv.setupDatabasePath,
};

/**
 * Puts a user into the database of an app the way the import of an existing installation leaves one: a user
 * who signed in with GitHub before accounts existed, a member of the default workspace (see
 * src/test-support/e2e-accounts-child.ts). The first sign in as that GitHub account is found by its numeric id.
 */
export async function importGithubUser(
  account: GithubAccount,
  app: AppUnderTest,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      ACCOUNTS_CHILD,
      "import-user",
      resolve(process.cwd(), DATABASES[app]),
      JSON.stringify({
        githubId: account.id,
        login: account.login,
        name: account.name,
        role,
      }),
    ],
    { cwd: process.cwd() },
  );
}

/**
 * Each spec file owns its accounts (own id and login); nobody resets the fake while others run. With `app`,
 * the account also exists in that app as an imported user and a member (so a journey that signs in finds the
 * workspace); without, it is a GitHub account nobody here knows.
 */
export async function addGithubAccount(
  request: APIRequestContext,
  account: GithubAccount,
  app: AppUnderTest | null = "main",
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  const response = await request.post(`${e2eEnv.githubUrl}/__fake/users`, {
    data: account,
  });
  expect(response.status()).toBe(201);
  if (app !== null) await importGithubUser(account, app, role);
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

export type GithubPullRequest = {
  number: number;
  title: string;
  state?: "open" | "closed";
  draft?: boolean;
  /** The head commit. Derived from the number when omitted, so every pull request has its own. */
  headSha?: string;
  author?: { login: string; id: number };
};

/**
 * Puts a pull request into a repository of the fake GitHub (replacing one with the same number). The
 * head commit is derived from the number, so every pull request has its own.
 */
export async function addGithubPullRequest(
  request: APIRequestContext,
  repositoryFullName: string,
  pullRequest: GithubPullRequest,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/pull-requests`,
    {
      data: {
        repository: repositoryFullName,
        pullRequest: {
          state: "open",
          headSha: String(pullRequest.number).padStart(40, "a"),
          headRef: `feature/${String(pullRequest.number)}`,
          baseRef: "main",
          author: { login: "alice", id: 1001 },
          ...pullRequest,
        },
      },
    },
  );
  expect(response.status()).toBe(201);
}

export type GithubComment = {
  id: number;
  body: string;
  login: string;
  htmlUrl: string;
  /** 1 when written, plus one for every edit. */
  revision: number;
};

/** The comments below a pull request at the fake GitHub, oldest first. */
export async function getPullRequestComments(
  request: APIRequestContext,
  repositoryFullName: string,
  number: number,
): Promise<GithubComment[]> {
  const response = await request.get(`${e2eEnv.githubUrl}/__fake/comments`, {
    params: { repository: repositoryFullName, number },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as GithubComment[];
}

/** Every installation token the fake GitHub has issued so far (to search outputs for them). */
export async function getIssuedInstallationTokens(
  request: APIRequestContext,
): Promise<string[]> {
  const response = await request.get(
    `${e2eEnv.githubUrl}/__fake/installation-tokens`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as string[];
}
