// SPDX-License-Identifier: Apache-2.0

// Helpers for the journeys that sign in: add an account to the fake GitHub that Playwright started
// next to the app, and walk through the sign in form the way a person does.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { WorkspaceRole } from "../../src/workspaces/roles";
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

/**
 * Opens the app, signs in as `account` at the fake GitHub and waits for the signed in app (the user menu with
 * their name). Being on the allow list admits a person to the app, it does not give them a workspace: the
 * account is made a member of the workspace of the app (the first one) with `role`, the way the import of an
 * existing installation does, and the app is opened again. Pass `role: null` for a journey about the
 * account that has none.
 */
export async function signInThroughTheForm(
  page: Page,
  account: GithubAccount,
  options: { role?: WorkspaceRole | null } = {},
): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page
    .getByRole("button", { name: `Authorize ${account.login}` })
    .click();
  const role = options.role === undefined ? "owner" : options.role;
  if (role === null) {
    await expect(userMenuButton(page, account)).toBeVisible();
    return;
  }
  // Without a workspace the app shows the page that says so; with one it shows the projects.
  await expect(page).toHaveURL(/\/(no-access|w\/[a-z0-9-]+\/projects)$/);
  if (page.url().endsWith("/no-access")) {
    await joinWorkspace(page, account, role);
    await page.goto("/");
  }
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+\/projects$/);
  await expect(userMenuButton(page, account)).toBeVisible();
}

const run = promisify(execFile);

/** The SQLite file of the app a page is open at (the apps of a run each have their own). */
function databaseOf(page: Page): string {
  const origin = new URL(page.url()).origin;
  const file =
    origin === e2eEnv.pipelineAppUrl
      ? e2eEnv.pipelineDatabasePath
      : origin === e2eEnv.signupAppUrl
        ? e2eEnv.signupDatabasePath
        : e2eEnv.databasePath;
  return resolve(process.cwd(), file);
}

/** Makes the account a member of a workspace of the app the page is open at (the first one by default). */
export async function joinWorkspace(
  page: Page,
  account: GithubAccount,
  role: WorkspaceRole,
  workspace?: string,
): Promise<void> {
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      resolve(process.cwd(), "src/test-support/e2e-membership-child.ts"),
      "join",
      databaseOf(page),
      JSON.stringify({ login: account.login, role, workspace }),
    ],
    { cwd: process.cwd() },
  );
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
