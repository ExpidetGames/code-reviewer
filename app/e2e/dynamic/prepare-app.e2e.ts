// SPDX-License-Identifier: Apache-2.0

// Not a journey: the first thing the privileged Dynamic e2e lane does with its app (#253). The app starts
// without a database, so it is a new instance that waits for the first-run setup; this sets it up through
// the routes of the wizard and enters the GitHub App of the fake GitHub in its admin portal, the way
// e2e/setup/prepare-apps.e2e.ts does for the apps of the other journeys.
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { enterGithubApp, setUpApp } from "../helpers/setup";

test("the app of the Dynamic lane is set up before the journey runs", async ({
  request,
}) => {
  await setUpApp(e2eEnv.pipelineAppUrl, e2eEnv.logFiles.pipeline);
  await enterGithubApp(e2eEnv.pipelineAppUrl);

  const page = await request.get(e2eEnv.pipelineAppUrl, { maxRedirects: 0 });
  expect(page.status()).toBe(307);
});
