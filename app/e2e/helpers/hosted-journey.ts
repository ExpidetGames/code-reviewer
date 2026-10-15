// SPDX-License-Identifier: Apache-2.0

// What the journeys of the hosted lane (#332) have in common: the shape of a pull request of the fake GitHub, the Runs
// page, and the check that no credential of the lane is anywhere a person or a log could see it.
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { llmEnv } from "./e2e-env";
import { getIssuedInstallationTokens } from "./github-fake";
import { hostedSecrets } from "./hosted-env";
import { signInAsAdmin } from "./hosted-instance";

/** The marker PR-Agent's review comment carries. */
export const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
/** A review through the real PR-Agent takes a few seconds; the first one also loads PR-Agent. */
export const RUN_TIMEOUT = { timeout: 120_000 };

/** A head commit that is different for every pull request and every push (`variant`). */
export const headSha = (variant: string, number: number) =>
  variant + String(number).padStart(39, "0");

/** The rows of the Runs page that belong to a pull request. */
export function runsOf(page: Page, repository: string, number: number) {
  return page
    .locator("[data-run-id]")
    .filter({ hasText: repository })
    .filter({ hasText: `#${String(number)}` });
}

/** Signs in as the admin and opens the Runs page. */
export async function openRuns(page: Page): Promise<void> {
  await signInAsAdmin(page);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Runs" }),
  ).toBeVisible();
}

/**
 * The credentials of the lane (the dispatcher credential, the signing secret, the cron secret, the master key, the
 * workspace's LLM key) and every installation token the fake GitHub issued are nowhere in the page, the runs API or the
 * texts the caller gives (the logs it has at hand).
 */
export async function expectNoCredentials(
  page: Page,
  request: APIRequestContext,
  texts: Record<string, string>,
  moreSecrets: string[] = [],
): Promise<void> {
  const tokens = await getIssuedInstallationTokens(request);
  expect(tokens.length).toBeGreaterThan(0);
  const secrets = [
    ...hostedSecrets(),
    llmEnv.apiKey,
    ...tokens,
    ...moreSecrets,
  ];
  const runs = await page.request.get("/api/w/default/runs");
  expect(runs.status()).toBe(200);
  const everything: Record<string, string> = {
    "the page": await page.content(),
    "the runs API": await runs.text(),
    ...texts,
  };
  for (const [name, text] of Object.entries(everything))
    for (const secret of secrets)
      expect(text, `a credential is in ${name}`).not.toContain(secret);
}

/** The value, or a failure that names what is missing: for what a journey needs and an earlier step should have made. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing.`);
  return value;
}
