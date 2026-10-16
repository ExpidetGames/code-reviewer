// SPDX-License-Identifier: Apache-2.0

// The pool cap of the hosted deployment (#332-T08): the Dispatcher claims for a pool of one. While the Worker of the first
// job runs, the call for a second job claims nothing (the app enforces the cap at the claim, atomically), so no
// second sandbox is created; the job waits in the queue, and when the slot is free the app's sweep sends it again and it
// runs. The Worker of the first job is held (its container is started and does nothing) so that "while it runs" is a state
// the journey controls rather than a race.
import { expect, test } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubPullRequest,
  getPullRequestComments,
} from "../helpers/github-fake";
import { dispatchOf, letTimePass, onlyJobOf } from "../helpers/hosted-db";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import {
  eventually,
  OWNER,
  runSweep,
  setUpReviewedRepositories,
  sweepUntil,
} from "../helpers/hosted-instance";
import {
  headSha,
  openRuns,
  required,
  RUN_TIMEOUT,
  runsOf,
} from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const INSTALLATION_ID = 9500303;
const REPOSITORY = { id: 9700003, fullName: "hosted-capacity/widgets" };
const OWNER_OF_REPOSITORY = { login: "hosted-capacity", id: OWNER.id };

test.describe("a pool of one Worker", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journeys project has no baseURL.");
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    dispatcher = await startHostedDispatcher({ llmBaseUrl: llm.baseUrl });
    await setUpReviewedRepositories(browser, baseURL, {
      installationId: INSTALLATION_ID,
      repositories: [REPOSITORY],
      active: [REPOSITORY.fullName],
    });
  });

  test.afterAll(async () => {
    dispatcher?.holdWorkers(false);
    try {
      await dispatcher?.stop();
    } finally {
      await llm?.close();
    }
  });

  // #332-T08
  test("a second job waits while the first one runs and flows when the slot is free", async ({
    page,
    request,
  }) => {
    const theDispatcher = required(dispatcher, "The Dispatcher");
    const theLlm = required(llm, "The fake LLM");
    const open = async (number: number, variant: string) => {
      const head = headSha(variant, number);
      await addGithubPullRequest(request, REPOSITORY.fullName, {
        number,
        title: `Pull request ${String(number)}`,
        headSha: head,
      });
      const answer = await deliverPullRequestEvent(request, {
        action: "opened",
        installationId: INSTALLATION_ID,
        repository: { ...REPOSITORY, owner: OWNER_OF_REPOSITORY },
        number,
        title: `Pull request ${String(number)}`,
        headSha: head,
      });
      expect(answer.outcome).toBe("trigger_enqueued");
      return onlyJobOf(REPOSITORY.fullName, number);
    };
    await openRuns(page);

    // The first job is claimed and its container is up, but its Worker has not started.
    theDispatcher.holdWorkers(true);
    const first = await open(30, "1");
    await eventually("the first job to be running", async () => {
      return (
        (await onlyJobOf(REPOSITORY.fullName, 30)).status === "running" &&
        theDispatcher.workersOf(first.id).length === 1
      );
    });

    // The Worker has taken over (the launch is over, so the Dispatcher's own count of launches is free again): the
    // second job's call is refused at the claim, by the app, which counts the jobs running in the pool.
    await eventually("the first launch to be over", async () =>
      theDispatcher
        .output()
        .includes(`"event":"launched","jobId":"${first.id}"`),
    );
    const second = await open(31, "2");
    await eventually("the call for the second job to be answered", async () => {
      const dispatch = await dispatchOf(second.id);
      return dispatch?.lastStatus === 200;
    });
    expect(await dispatchOf(second.id)).toMatchObject({
      state: "pending",
      lastStatus: 200,
      consecutiveFailures: 0,
    });
    expect((await onlyJobOf(REPOSITORY.fullName, 31)).status).toBe("queued");
    expect(theDispatcher.workersOf(second.id)).toHaveLength(0);
    expect(theDispatcher.output()).toContain('"event":"claim_none"');
    // The cron comes by: the pool is full, so it sends nothing for the second job either (the app's sweep keeps to
    // the cap, RUNNER_DISPATCH_MAX_RUNNING).
    await letTimePass(second.id, 150);
    expect((await runSweep(request)).sent).toBe(0);
    expect(theDispatcher.workersOf(second.id)).toHaveLength(0);

    // The first Worker starts and finishes; the slot is free and the second job flows.
    theDispatcher.holdWorkers(false);
    const firstRun = runsOf(page, REPOSITORY.fullName, 30);
    await page.reload();
    await expect(firstRun.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    await sweepUntil(request, "the second job to be sent", async () => {
      return theDispatcher.workersOf(second.id).length === 1;
    });
    const secondRun = runsOf(page, REPOSITORY.fullName, 31);
    await page.reload();
    await expect(secondRun.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    // Each pull request has its comment, each job ran in a container of its own, one after the other.
    for (const number of [30, 31])
      expect(
        await getPullRequestComments(request, REPOSITORY.fullName, number),
      ).toHaveLength(1);
    expect(theLlm.requests()).toHaveLength(2);
    expect(theDispatcher.workersOf(first.id)).toHaveLength(1);
    expect(theDispatcher.workersOf(second.id)).toHaveLength(1);
    expect((await onlyJobOf(REPOSITORY.fullName, 31)).attempts).toBe(0);
  });
});
