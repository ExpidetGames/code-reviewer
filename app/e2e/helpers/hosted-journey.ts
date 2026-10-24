// SPDX-License-Identifier: LicenseRef-Proprietary

// What the journeys of the hosted lane (#332) have in common: the shape of a pull request of the fake GitHub, the Runs
// page, and the check that no credential of the lane is anywhere a person or a log could see it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { llmEnv } from "./e2e-env";
import { getIssuedInstallationTokens } from "./github-fake";
import { hostedEnv, hostedSecrets } from "./hosted-env";
import { signInAsAdmin } from "./hosted-instance";
import { allSecrets, containsSecret } from "./hosted-secrets";

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
    // The per-job credentials of every Worker so far, the session cookies and the setup code (hosted-secrets.ts).
    ...allSecrets(),
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
      expect(containsSecret(text, secret), `a credential is in ${name}`).toBe(
        false,
      );
}

/** The value, or a failure that names what is missing: for what a journey needs and an earlier step should have made. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing.`);
  return value;
}

/**
 * The `docker run` the Sandbox-Launcher renders for a Diff job, whole: the golden file of the renderer's own test
 * (`dispatcher/src/launchers/testdata/docker-run.sandbox.golden.json`, kept equal to the hardened spec by
 * `container.test.ts`) with what differs for a job put in: the container's name, the image id, and the environment the
 * Launcher adds (the Diff job user and the job's timeout). A flag that is dropped or changed, or one that is added,
 * makes the arguments the stand-in recorded differ from it.
 */
export function goldenDockerRun(
  jobId: string,
  timeoutSeconds: number,
): string[] {
  const golden = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "../dispatcher/src/launchers/testdata/docker-run.sandbox.golden.json",
      ),
      "utf8",
    ),
  ) as string[];
  const name = golden.indexOf("--name");
  const environment = golden.indexOf("--env");
  const image = golden.indexOf("worker-once") - 1;
  if (name < 0 || environment < 0 || image < 0)
    throw new Error("The golden file of the renderer has changed its shape.");
  const result = [...golden];
  result[name + 1] = `code-reviewer-worker-${jobId}`;
  result[image] = hostedEnv.imageId;
  // The renderer sorts the environment by name: HOME, RUNNER_DIFF_JOB_USER, RUNNER_JOB_TIMEOUT_SECONDS.
  result.splice(
    environment + 2,
    0,
    "--env",
    "RUNNER_DIFF_JOB_USER=10001:10001",
    "--env",
    `RUNNER_JOB_TIMEOUT_SECONDS=${String(timeoutSeconds)}`,
  );
  return result;
}
