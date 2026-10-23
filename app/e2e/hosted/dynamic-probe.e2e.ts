// SPDX-License-Identifier: Apache-2.0

// A Dynamic job on a deployment whose container cannot prove its hardening (#332-T09, #479): the deploy canary of #331 is
// the only proof a deployment has (#479), so the Dispatcher runs no probe when a job is dispatched. The canary here runs
// the real `probe` entry mode of the Worker through the real Sandbox-Launcher, in a process that is not root and has no
// capabilities, so the container's own startup cannot establish its hardening and the verdict has no `opencode`:
//
//  - the deploy canary (`pnpm probe:canary`, the release gate) fails with exit 1 and no credential in its output; that is
//    what keeps such a deployment from going live;
//  - if such a deployment is live anyway, a Dynamic job's call is accepted at once (no `503` for a probe, no canary VM),
//    and the Worker's own startup self-check refuses to run the review: the run fails with `dynamic_engine_unavailable`,
//    no model is called, and the page says what that means (defence in depth, not the gate);
//  - a Diff job of another project, on the same Dispatcher, is reviewed as ever.
// The privileged lane (e2e/dynamic/hosted-dynamic.e2e.ts) is the same Dispatcher with a container that does prove it.
import { expect, test } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { changeAdminSetting } from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubPullRequest,
  getPullRequestComments,
} from "../helpers/github-fake";
import { dispatchOf, onlyJobOf } from "../helpers/hosted-db";
import { hostedEnv } from "../helpers/hosted-env";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import {
  chooseDynamicReview,
  eventually,
  OWNER,
  runDeployCanary,
  setUpReviewedRepositories,
  signInAsAdmin,
} from "../helpers/hosted-instance";
import {
  headSha,
  openRuns,
  REVIEW_MARKER,
  RUN_TIMEOUT,
  runsOf,
} from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const INSTALLATION_ID = 9500304;
const DYNAMIC = { id: 9700004, fullName: "hosted-probe/dynamic" };
const DIFF = { id: 9700005, fullName: "hosted-probe/diff" };
const OWNER_OF_REPOSITORIES = { login: "hosted-probe", id: OWNER.id };
// The model name a person types into the project's settings.
const MODEL = "deepseek/deepseek-v4-pro";

test.describe.configure({ mode: "serial" });

test.describe("a Dynamic job where the container's hardening cannot be proven", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journeys project has no baseURL.");
    // At the address the app asks for the metadata of the Dynamic model it saves (#269).
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    llm.setModel(MODEL, [
      {
        supported_parameters: ["tools", "tool_choice"],
        context_length: 200_000,
        pricing: { prompt: "0.0000005", completion: "0.000002" },
      },
    ]);
    dispatcher = await startHostedDispatcher({
      llmBaseUrl: llm.baseUrl,
      engines: "pr-agent,opencode",
      dynamic: {
        capabilities: JSON.stringify({
          tool_choice_required: true,
          structured_output: true,
          max_output_tokens: 4096,
          input_usd_per_mtok: 1,
          output_usd_per_mtok: 4,
        }),
        maxCostUsd: "1",
      },
    });
    await setUpReviewedRepositories(browser, baseURL, {
      installationId: INSTALLATION_ID,
      repositories: [DYNAMIC, DIFF],
      active: [DYNAMIC.fullName, DIFF.fullName],
    });
    // The gate is off in every shipped configuration; the instance admin turns it on, then a person chooses Dynamic
    // Review for the project.
    await changeAdminSetting(baseURL, { dynamicReview: { enabled: true } });
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await signInAsAdmin(page);
      await chooseDynamicReview(page, DYNAMIC.fullName, MODEL);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async () => {
    try {
      await dispatcher?.stop();
    } finally {
      await llm?.close();
    }
  });

  function theDispatcher(): HostedDispatcher {
    if (dispatcher === undefined)
      throw new Error("The Dispatcher was not started.");
    return dispatcher;
  }

  // #332-T09
  test("the deploy canary fails; a Dynamic job on that deployment is accepted at once without a probe and refused by the Worker's own self-check, and a Diff job on the same Dispatcher is reviewed", async ({
    page,
    request,
  }) => {
    // The release gate: the canary VM ran the real probe and the container could not vouch for itself.
    const canary = await runDeployCanary(120);
    expect(canary.code).toBe(1);
    // The container's own startup said why: it could not end its startup capabilities (this process is no root).
    expect(canary.output).toContain("reasons=capabilities_not_dropped");
    expect(canary.output).toContain("missing=opencode");
    expect(theDispatcher().output()).toContain(
      '"event":"probe_denied","reasons":["capabilities_not_dropped"]',
    );
    expect(canary.output).not.toContain(hostedEnv.dispatcherToken);
    const probes = theDispatcher()
      .containers()
      .filter((container) => container.mode === "probe");
    expect(probes).toHaveLength(1);
    // The canary has no job, no URL and no credential: its container was given the flags of a Dynamic Worker and nothing of the app.
    expect(probes[0]?.args.join("\n")).not.toContain(hostedEnv.appUrl);

    // A Dynamic job: the signed call is accepted at once and no probe runs for it (the canary above is the only one).
    await openRuns(page);
    const dynamicNumber = 40;
    const dynamicHead = headSha("1", dynamicNumber);
    await addGithubPullRequest(request, DYNAMIC.fullName, {
      number: dynamicNumber,
      title: "Add a user handler",
      headSha: dynamicHead,
    });
    expect(
      await deliverPullRequestEvent(request, {
        action: "opened",
        installationId: INSTALLATION_ID,
        repository: { ...DYNAMIC, owner: OWNER_OF_REPOSITORIES },
        number: dynamicNumber,
        title: "Add a user handler",
        headSha: dynamicHead,
      }),
    ).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
    const dynamicJob = await onlyJobOf(DYNAMIC.fullName, dynamicNumber);
    expect(dynamicJob.reviewKind).toBe("dynamic");
    await eventually(
      "the Worker's own self-check to refuse the Dynamic job",
      async () =>
        (await onlyJobOf(DYNAMIC.fullName, dynamicNumber)).status === "failed",
      90_000,
    );
    // The first call was accepted: no 503 and no second call for a probe, one Worker was started for it ...
    expect(await dispatchOf(dynamicJob.id)).toMatchObject({
      state: "acked",
      attempts: 1,
      consecutiveFailures: 0,
      lastStatus: 202,
    });
    expect(theDispatcher().output()).not.toContain('"event":"not_capable"');
    expect(theDispatcher().output()).not.toContain("capabilities_pending");
    expect(theDispatcher().workersOf(dynamicJob.id)).toHaveLength(1);
    // ... and the only canary container is the one the deploy canary asked for.
    expect(
      theDispatcher()
        .containers()
        .filter((container) => container.mode === "probe"),
    ).toHaveLength(1);
    expect(await onlyJobOf(DYNAMIC.fullName, dynamicNumber)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_engine_unavailable",
    });
    // The refusal came before any model call.
    expect(llm?.requests() ?? []).toHaveLength(0);

    // A Diff job on the same Dispatcher is not affected.
    const diffNumber = 41;
    const diffHead = headSha("2", diffNumber);
    await addGithubPullRequest(request, DIFF.fullName, {
      number: diffNumber,
      title: "Add a greeting helper",
      headSha: diffHead,
    });
    await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...DIFF, owner: OWNER_OF_REPOSITORIES },
      number: diffNumber,
      title: "Add a greeting helper",
      headSha: diffHead,
    });
    await page.reload();
    await expect(
      runsOf(page, DIFF.fullName, diffNumber).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    const comments = await getPullRequestComments(
      request,
      DIFF.fullName,
      diffNumber,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(REVIEW_MARKER);

    expect(
      await getPullRequestComments(request, DYNAMIC.fullName, dynamicNumber),
    ).toEqual([]);
    await page.reload();
    const dynamicRun = runsOf(page, DYNAMIC.fullName, dynamicNumber);
    await expect(dynamicRun.locator("[data-status]")).toContainText("Failed");
    await dynamicRun
      .getByRole("link", {
        name: `${DYNAMIC.fullName} #${String(dynamicNumber)}`,
      })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("dynamic_engine_unavailable")).toBeVisible();
  });
});
