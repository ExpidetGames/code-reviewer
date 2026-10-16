// SPDX-License-Identifier: Apache-2.0

// Not a journey: the first thing a run of the hosted lane does. The app starts on a migrated, empty database, as a new
// deployment does after `pnpm migrate`; this sets it up through the same routes as the wizard, with a code from `pnpm
// setup-code` (there is no log to read it from in a serverless deployment), and enters the GitHub App of the fake GitHub
// in its admin portal, as an operator does.
import { expect, test } from "@playwright/test";
import { enterGithubApp } from "../helpers/setup";
import { hostedEnv } from "../helpers/hosted-env";
import { setUpHostedApp } from "../helpers/hosted-setup";

test.describe("the app of the hosted lane", () => {
  test("is set up with the code of pnpm setup-code and has the GitHub App before the first journey runs", async ({
    request,
  }) => {
    await setUpHostedApp(hostedEnv.appUrl);
    await enterGithubApp(hostedEnv.appUrl);

    const page = await request.get(hostedEnv.appUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });
});
