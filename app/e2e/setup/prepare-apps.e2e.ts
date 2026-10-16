// SPDX-License-Identifier: Apache-2.0

// Not a journey: the first thing a run does. The apps under test start without a database, so each
// one is a new instance that waits for the first-run setup and answers nothing else. This sets the
// ones that the other journeys use up (single-tenant, one admin), through the same routes as the
// wizard, with the code from the app's log. The two that sign people in and review also get the GitHub App,
// entered in their admin portal with the same form an operator uses (the dummy App of the fake GitHub). The
// journeys then see the instance they always saw: a login page, the projects, the runs. The third app is left alone on purpose: e2e/setup/first-run.e2e.ts
// walks through its wizard.
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { enterGithubApp, setUpApp } from "../helpers/setup";

test.describe("the apps under test", () => {
  test("the app of the journeys is set up before the first journey runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.appUrl, e2eEnv.logFiles.app);
    await enterGithubApp(e2eEnv.appUrl);

    const page = await request.get(e2eEnv.appUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the app of the sign-up journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.signupAppUrl, e2eEnv.logFiles.signup);

    const page = await request.get(e2eEnv.signupAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the multi-tenant app of the workspace journeys is set up before they run", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.multiAppUrl, e2eEnv.logFiles.multi, "multi");
    await enterGithubApp(e2eEnv.multiAppUrl);

    const page = await request.get(e2eEnv.multiAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });

  test("the operator app of the limits journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.operatorAppUrl, e2eEnv.logFiles.operator, "multi");
    await enterGithubApp(e2eEnv.operatorAppUrl);

    const page = await request.get(e2eEnv.operatorAppUrl, {
      maxRedirects: 0,
    });
    expect(page.status()).toBe(307);
  });

  test("the app of the real review journey is set up before it runs", async ({
    request,
  }) => {
    await setUpApp(e2eEnv.pipelineAppUrl, e2eEnv.logFiles.pipeline);
    await enterGithubApp(e2eEnv.pipelineAppUrl);

    const page = await request.get(e2eEnv.pipelineAppUrl, { maxRedirects: 0 });
    expect(page.status()).toBe(307);
  });
});
