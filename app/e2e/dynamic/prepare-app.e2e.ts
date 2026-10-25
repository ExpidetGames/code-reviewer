// SPDX-License-Identifier: LicenseRef-Proprietary

// Not a journey: the first thing the privileged Dynamic e2e lane does with its app (#253). The app starts on a
// migrated, empty database, so it is a new instance that waits for the first-run setup; this sets it up through
// the routes of the wizard and enters the GitHub App of the fake GitHub in its admin portal, the way
// e2e/setup/prepare-apps.e2e.ts does for the apps of the other journeys.
import { expect, test } from "@playwright/test";
import { hostedDatabaseUrls, hostedEnv } from "../helpers/hosted-env";
import { enterGithubApp, setUpApp } from "../helpers/setup";

test("the app of the hosted journey of the Dynamic lane is set up before it runs", async ({
  request,
}) => {
  await setUpApp(hostedEnv.appUrl, hostedDatabaseUrls().app);
  await enterGithubApp(hostedEnv.appUrl);

  const page = await request.get(hostedEnv.appUrl, { maxRedirects: 0 });
  expect(page.status()).toBe(307);
});
