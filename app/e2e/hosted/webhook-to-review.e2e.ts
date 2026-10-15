// SPDX-License-Identifier: Apache-2.0

// The whole hosted flow of a review on fakes (#332-T01, T07): a signed `pull_request` webhook reaches the real app (serverless
// mode, Postgres), the app queues the job and wakes the real Dispatcher with a signed call, the Dispatcher claims
// exactly that job, its Sandbox-Launcher starts a VM and runs the hardened container's `docker run` (here the stand-in
// that runs the real Worker as a local process), the real Worker (`worker-once`) fetches its job with the per-job
// credential, runs the real PR-Agent against the fake GitHub and the fake LLM, heartbeats and delivers the result; the
// review comment lands on the fake pull request and the Runs page shows the run as succeeded. Nothing in between is
// replaced. What each piece does in detail is proven at lower levels; this file proves they fit together.
import { expect, test } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubPullRequest,
  getPullRequestComments,
} from "../helpers/github-fake";
import { dispatchOf, jobsOf, onlyJobOf } from "../helpers/hosted-db";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import {
  eventually,
  OWNER,
  setUpReviewedRepositories,
} from "../helpers/hosted-instance";
import {
  expectNoCredentials,
  headSha,
  openRuns,
  required,
  REVIEW_MARKER,
  RUN_TIMEOUT,
  runsOf,
} from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const INSTALLATION_ID = 9500301;
const WIDGETS = { id: 9700001, fullName: "hosted-journey/widgets" };
const OWNER_OF_WIDGETS = { login: "hosted-journey", id: OWNER.id };

test.describe.configure({ mode: "serial" });

test.describe("a pull request on its way to a review through the hosted deployment", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journeys project has no baseURL.");
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    dispatcher = await startHostedDispatcher({ llmBaseUrl: llm.baseUrl });
    await setUpReviewedRepositories(browser, baseURL, {
      installationId: INSTALLATION_ID,
      repositories: [WIDGETS],
      active: [WIDGETS.fullName],
    });
  });

  test.beforeEach(() => {
    fakeLlm().reset();
  });

  test.afterAll(async () => {
    try {
      await dispatcher?.stop();
    } finally {
      await llm?.close();
    }
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }
  function theDispatcher(): HostedDispatcher {
    if (dispatcher === undefined)
      throw new Error("The Dispatcher was not started.");
    return dispatcher;
  }

  // #332-T01
  test("a person opens a pull request: the signed wake-up call, the claim by id, a sandbox, the real Worker and the review on the pull request, shown as succeeded in the Runs page", async ({
    page,
    request,
  }) => {
    const number = 7;
    const head = headSha("1", number);
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER_OF_WIDGETS },
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    const run = runsOf(page, WIDGETS.fullName, number);
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    await expect(run).toContainText("Automatic");

    // Exactly one comment, written by the bot of the app, holding the review of the model.
    const comments = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.login).toBe(e2eEnv.githubBotLogin);
    expect(comments[0]?.body).toContain(REVIEW_MARKER);
    expect(comments[0]?.revision).toBe(1);

    // The model was asked once, with the key of the workspace, about the diff of the fake GitHub.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${llmEnv.apiKey}`);
    expect(asked[0]?.prompt).toContain("greeting.py");

    // The job went the way of the design: queued, announced and acknowledged (202), claimed by id, run once, no
    // attempt lost.
    const job = await onlyJobOf(WIDGETS.fullName, number);
    expect(job).toMatchObject({
      status: "succeeded",
      attempts: 0,
      errorCode: null,
    });
    expect(await dispatchOf(job.id)).toMatchObject({
      state: "acked",
      lastStatus: 202,
      consecutiveFailures: 0,
    });
    const workers = theDispatcher().workersOf(job.id);
    expect(workers).toHaveLength(1);

    // The container was started with the flags of the hardened spec, and nothing of the Dispatcher's or the App's
    // secrets was given to it: the credential of the job came on stdin, which no record of the stand-in holds.
    const flags = workers[0]?.args.join(" ") ?? "";
    for (const flag of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--read-only",
      "--pids-limit 512",
      "--sysctl net.ipv6.conf.all.disable_ipv6=1",
    ])
      expect(flags).toContain(flag);
    const worker = required(workers[0], "The Worker");
    for (const forbidden of [
      "--privileged",
      "--volume",
      "-v",
      "--mount",
      "--device",
      "--pid",
      "--ipc",
      "--uts",
      "--userns",
      "--cgroupns",
    ])
      expect(worker.args).not.toContain(forbidden);
    expect(flags).toContain("--network bridge");
    expect(worker.environment).not.toMatch(
      /RUNNER_TOKEN|DISPATCHER_|CRON_SECRET|APP_SECRET/,
    );

    await expectNoCredentials(page, request, {
      "the Dispatcher's output": theDispatcher().output(),
      "the Worker's log": worker.log(),
      "the Worker's flags": worker.args.join("\n"),
      "the Worker's environment": worker.environment,
    });
    expect(
      `${theDispatcher().output()}${worker.log()}${worker.args.join("")}`,
    ).not.toMatch(/crj_[A-Za-z0-9_-]{8,}/);
  });

  // #332-T07
  test("the same webhook delivered twice and a second delivery for the same commit make one run, one Worker and one comment", async ({
    page,
    request,
  }) => {
    const number = 8;
    const head = headSha("2", number);
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a farewell helper",
      headSha: head,
    });
    await openRuns(page);
    const delivery = {
      action: "opened" as const,
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER_OF_WIDGETS },
      number,
      title: "Add a farewell helper",
      headSha: head,
    };

    const first = await deliverPullRequestEvent(request, {
      ...delivery,
      deliveryId: "e2e-duplicate-delivery-0001",
    });
    const again = await deliverPullRequestEvent(request, {
      ...delivery,
      deliveryId: "e2e-duplicate-delivery-0001",
    });
    const other = await deliverPullRequestEvent(request, {
      ...delivery,
      deliveryId: "e2e-duplicate-delivery-0002",
    });

    expect(first.outcome).toBe("trigger_enqueued");
    expect(again.outcome).toBe("duplicate");
    const run = runsOf(page, WIDGETS.fullName, number);
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    // A delivery for the commit that is already queued or reviewed makes no second job.
    expect(other.status).toBe("accepted");
    const jobs = await jobsOf(WIDGETS.fullName, number);
    expect(jobs).toHaveLength(1);
    await expect(run).toHaveCount(1);

    // One Worker, one model call and one comment: the replays of the call that woke the Dispatcher claimed nothing.
    const job = required(jobs[0], "The job");
    await eventually("the Worker's container to be gone", async () => {
      return theDispatcher().workersOf(job.id).length === 1;
    });
    expect(theDispatcher().workersOf(job.id)).toHaveLength(1);
    expect(fakeLlm().requests()).toHaveLength(1);
    expect(
      await getPullRequestComments(request, WIDGETS.fullName, number),
    ).toHaveLength(1);
  });
});
