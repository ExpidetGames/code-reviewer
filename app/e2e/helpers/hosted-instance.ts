// SPDX-License-Identifier: Apache-2.0

// What a person does once at an app of the hosted lane (#332) and what the journeys do to it all the time: sign in
// as the instance admin (the lane's apps have no GitHub sign-in set up: the database is Postgres), install the GitHub
// App for the repositories at the fake GitHub, sync, save the workspace's LLM key and switch a project on, and the app's own
// cron: the sweep (`GET /api/internal/dispatch-sweep`, #328).
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { syncFromGithubAsAdmin } from "./admin-api";
import { e2eEnv, llmEnv } from "./e2e-env";
import { addGithubInstallation, GITHUB_APP_OWNER_ACCOUNT } from "./github-fake";
import { hostedEnv } from "./hosted-env";

/** The owner of the repositories the journeys review: the account the fake reports as the owner of the App. */
export const OWNER = {
  login: GITHUB_APP_OWNER_ACCOUNT.login,
  id: GITHUB_APP_OWNER_ACCOUNT.id,
};

/** Signs in as the instance admin through the same route as the sign in form; the page's cookies hold the session. */
export async function signInAsAdmin(page: Page): Promise<void> {
  const signedIn = await page.request.post("/api/auth/sign-in/email", {
    data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+\/projects$/);
}

/** Saves the LLM key of the first workspace, as an Owner does in the settings (the account is signed in). */
export async function saveWorkspaceKey(
  page: Page,
  apiKey: string,
): Promise<void> {
  const saved = await page.request.put("/api/w/default/llm-key", {
    data: { provider: llmEnv.provider, apiKey },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Switches the project of a repository on in the projects page, unless it already is. */
export async function switchProjectOn(
  page: Page,
  fullName: string,
): Promise<void> {
  await page.goto("/");
  const row = page.getByRole("row").filter({ hasText: fullName });
  await expect(row).toBeVisible();
  if ((await row.getByText("Active", { exact: true }).count()) === 0)
    await row.getByRole("switch", { name: `Review ${fullName}` }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
}

/**
 * The one-time setup of a person: the GitHub App is installed for these repositories at the fake, the app reads them,
 * the workspace has its LLM key and the projects of `active` are switched on (the other repositories stay off).
 * Returns the signed-in page's context closed: the journeys sign in again where they need a page.
 */
export async function setUpReviewedRepositories(
  browser: Browser,
  baseURL: string,
  options: {
    installationId: number;
    repositories: Array<{ id: number; fullName: string }>;
    active: string[];
  },
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await addGithubInstallation(
      context.request,
      { id: options.installationId, account: GITHUB_APP_OWNER_ACCOUNT },
      options.repositories,
    );
    await syncFromGithubAsAdmin(baseURL);
    await signInAsAdmin(page);
    await saveWorkspaceKey(page, llmEnv.apiKey);
    for (const fullName of options.active)
      await switchProjectOn(page, fullName);
  } finally {
    await context.close();
  }
}

export type SweepAnswer = {
  status: string;
  expired?: Record<string, number>;
  givenUp?: number;
  revived?: number;
  sent?: number;
  cleanedUp?: boolean;
};

/** One run of the app's cron sweep, as the platform's cron calls it (`Authorization: Bearer <CRON_SECRET>`). */
export async function runSweep(
  request: APIRequestContext,
): Promise<SweepAnswer> {
  const response = await request.get(
    `${hostedEnv.appUrl}/api/internal/dispatch-sweep`,
    { headers: { authorization: `Bearer ${hostedEnv.cronSecret}` } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as SweepAnswer;
}

/**
 * Runs the sweep until `done` holds, the way the cron does every minute, but looking every half second: for what
 * takes the app a moment to answer (a send is acknowledged a moment after it was claimed).
 */
export async function sweepUntil(
  request: APIRequestContext,
  what: string,
  done: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await runSweep(request);
    if (await done()) return;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Waits for an asynchronous condition. */
export async function eventually(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  let holds = false;
  const deadline = Date.now() + timeoutMs;
  while (!holds) {
    holds = await condition();
    if (holds) return;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
