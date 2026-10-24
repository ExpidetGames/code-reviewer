// SPDX-License-Identifier: LicenseRef-Proprietary

// What goes wrong between the app and a Worker in the hosted deployment, and what the app does about it (#332-T03 to T06),
// with the real app, the real Dispatcher and the real Worker, and time passing where the real waits are minutes long
// (the journey moves the clock of one job in the database, e2e/helpers/hosted-db.ts, and calls the app's own cron sweep,
// which the platform's cron runs every two hours and which is only the safety net: what happens in the normal flow
// happens without it, #395):
//
//  - the Dispatcher is down for a moment when a job is queued: the app repeats the call inside the request and the review
//    runs once, no sweep (#395-T06);
//  - the Dispatcher is not ready and answers 503 with a Retry-After of a few seconds (a cold or launching instance): the
//    app waits for it inside the request and the review runs once, no sweep (#479);
//  - the Dispatcher answers 503 with a Retry-After longer than a request waits for: the job is woken by the next job that
//    ends, no sweep and no clock moved (#479);
//  - the Dispatcher is down for longer than the repeats: the sweep sends the call again when it is back and the review
//    runs once;
//  - the Dispatcher stays down past the give-up: the run fails with `dispatch_unavailable`, the page says what it means,
//    and the pull request is free for the next push;
//  - the platform refuses to create a sandbox: every refusal counts as a lost attempt, the Dispatcher gives the job back
//    and the app announces it again at once, and after three the run fails with `launch_failed` without any Worker having
//    started;
//  - a Worker dies in the middle of a review: the Dispatcher holds no supervision after the hand-over (#487), so the lease
//    runs out, the sweep puts the job back and a second Worker finishes it (#332-T06);
//  - a Worker that took over and keeps ending with an error: every lost lease costs an attempt, and after three the run
//    fails with `lease_expired` (#487, replacing #375-T02, which relied on the Dispatcher's supervision).
import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv } from "../helpers/e2e-env";
import { hostedEnv } from "../helpers/hosted-env";
import {
  addGithubPullRequest,
  getPullRequestComments,
} from "../helpers/github-fake";
import {
  dispatchOf,
  jobsOf,
  letTimePass,
  onlyJobOf,
} from "../helpers/hosted-db";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import {
  eventually,
  OWNER,
  runSweep,
  setUpReviewedRepositories,
} from "../helpers/hosted-instance";
import {
  headSha,
  openRuns,
  required,
  REVIEW_MARKER,
  RUN_TIMEOUT,
  runsOf,
} from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const INSTALLATION_ID = 9500302;
const REPOSITORY = { id: 9700002, fullName: "hosted-failures/widgets" };
const OWNER_OF_REPOSITORY = { login: "hosted-failures", id: OWNER.id };

/**
 * Stands in for a Dispatcher that is not ready (#479): listens on the Dispatcher's address and answers every call with
 * `503` and a `Retry-After`. `release()` ends it, so the real Dispatcher can take the address.
 */
async function startNotReadyDispatcher(retryAfterSeconds: number): Promise<{
  calls(): number;
  release(): Promise<void>;
}> {
  let calls = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    calls += 1;
    response.writeHead(503, { "retry-after": String(retryAfterSeconds) });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(hostedEnv.dispatcherPort, "127.0.0.1", resolve);
  });
  return {
    calls: () => calls,
    // Ends the stand-in; ending it again is harmless.
    release: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe.configure({ mode: "serial" });

test.describe("what the hosted deployment does when the Dispatcher, the platform or a Worker fails", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journeys project has no baseURL.");
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    await setUpReviewedRepositories(browser, baseURL, {
      installationId: INSTALLATION_ID,
      repositories: [REPOSITORY],
      active: [REPOSITORY.fullName],
    });
  });

  test.beforeEach(() => {
    fakeLlm().reset();
  });

  test.afterEach(async () => {
    await stopDispatcher();
  });

  test.afterAll(async () => {
    await stopDispatcher();
    await llm?.close();
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }
  function theDispatcher(): HostedDispatcher {
    if (dispatcher === undefined)
      throw new Error("The Dispatcher is not running.");
    return dispatcher;
  }
  async function startDispatcher(): Promise<void> {
    dispatcher = await startHostedDispatcher({ llmBaseUrl: fakeLlm().baseUrl });
  }
  async function stopDispatcher(): Promise<void> {
    const running = dispatcher;
    dispatcher = undefined;
    await running?.stop();
  }

  /** A pull request of the repository and the signed webhook for it; returns the number. */
  async function openPullRequest(
    page: Page,
    request: import("@playwright/test").APIRequestContext,
    number: number,
    variant: string,
    options: { signedIn?: boolean } = {},
  ): Promise<{ number: number; head: string }> {
    const head = headSha(variant, number);
    await addGithubPullRequest(request, REPOSITORY.fullName, {
      number,
      title: `Pull request ${String(number)}`,
      headSha: head,
    });
    if (options.signedIn !== true) await openRuns(page);
    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...REPOSITORY, owner: OWNER_OF_REPOSITORY },
      number,
      title: `Pull request ${String(number)}`,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
    return { number, head };
  }

  /**
   * The app tried to send the call and could not: nobody listens. It tries once and repeats the call three times inside
   * the same request (#395), so the failures are counted to four before it leaves the job to its back-off.
   */
  async function waitForFailedSend(jobId: string): Promise<void> {
    await eventually(
      "the app's send and its repeats to fail",
      async () => {
        const dispatch = await dispatchOf(jobId);
        return dispatch !== null && dispatch.consecutiveFailures >= 4;
      },
      60_000,
    );
  }

  // #395-T06
  test("the Dispatcher is down for a moment when a job is queued: the app repeats the call inside the request and the review runs once, without a sweep", async ({
    page,
    request,
  }) => {
    const { number } = await openPullRequest(page, request, 26, "a");
    const job = await onlyJobOf(REPOSITORY.fullName, number);
    await eventually("the app's first send to fail", async () => {
      const dispatch = await dispatchOf(job.id);
      return dispatch !== null && dispatch.consecutiveFailures >= 1;
    });

    // Back before the last repeat: the lane widens the pauses of the repeats to 2, 6 and 10 seconds, so a slow runner
    // that needs several seconds to start the Dispatcher is still inside the window.
    await startDispatcher();

    const run = runsOf(page, REPOSITORY.fullName, number);
    await page.reload();
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    expect(theDispatcher().workersOf(job.id)).toHaveLength(1);
    expect(fakeLlm().requests()).toHaveLength(1);
    expect(await dispatchOf(job.id)).toMatchObject({ state: "acked" });
  });

  // #479-T07
  test("a Dispatcher that is not ready answers 503 with a Retry-After of a few seconds: the app waits for it inside the request and the review runs once, without a sweep", async ({
    page,
    request,
  }) => {
    const notReady = await startNotReadyDispatcher(3);
    try {
      const { number } = await openPullRequest(page, request, 27, "b");
      const job = await onlyJobOf(REPOSITORY.fullName, number);
      await eventually("the app's first call to be answered 503", async () => {
        return notReady.calls() >= 1;
      });
      expect(await dispatchOf(job.id)).toMatchObject({
        lastStatus: 503,
        lastCode: "unavailable",
      });
      // The Dispatcher becomes ready while the app waits for the Retry-After.
      await notReady.release();
      await startDispatcher();

      const run = runsOf(page, REPOSITORY.fullName, number);
      await page.reload();
      await expect(run.locator("[data-status]")).toContainText(
        "Succeeded",
        RUN_TIMEOUT,
      );
      // One 503, then calls the real Dispatcher answered: nothing waited for a sweep, and the job ran once.
      expect(notReady.calls()).toBe(1);
      expect(theDispatcher().workersOf(job.id)).toHaveLength(1);
      expect(fakeLlm().requests()).toHaveLength(1);
      expect(await dispatchOf(job.id)).toMatchObject({ state: "acked" });
    } finally {
      await notReady.release();
    }
  });

  // #479-T08
  test("a Dispatcher answers 503 with a Retry-After longer than a request waits for: the app does not wait, and the job that ends next wakes it, without a sweep or a moved clock", async ({
    page,
    request,
  }) => {
    const notReady = await startNotReadyDispatcher(120);
    try {
      const waiting = await openPullRequest(page, request, 28, "c");
      const job = await onlyJobOf(REPOSITORY.fullName, waiting.number);
      await eventually("the app's call to be answered 503", async () => {
        return notReady.calls() >= 1;
      });
      await notReady.release();
      // Not repeated inside the request: one call, and the row says "not before two minutes".
      expect(notReady.calls()).toBe(1);
      expect(await dispatchOf(job.id)).toMatchObject({
        state: "pending",
        lastStatus: 503,
        lastCode: "unavailable",
        attempts: 1,
      });
      await startDispatcher();
      // The last call of the waiting job is older than the gap that protects a call in flight.
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      // Another pull request is reviewed and its job ends: a slot freed, and the waiting job is asked, whatever its row says.
      const other = await openPullRequest(page, request, 29, "d", {
        signedIn: true,
      });
      const otherRun = runsOf(page, REPOSITORY.fullName, other.number);
      await page.reload();
      await expect(otherRun.locator("[data-status]")).toContainText(
        "Succeeded",
        RUN_TIMEOUT,
      );
      const waitingRun = runsOf(page, REPOSITORY.fullName, waiting.number);
      await page.reload();
      await expect(waitingRun.locator("[data-status]")).toContainText(
        "Succeeded",
        RUN_TIMEOUT,
      );
      expect(notReady.calls()).toBe(1);
      expect(theDispatcher().workersOf(job.id)).toHaveLength(1);
      expect(fakeLlm().requests()).toHaveLength(2);
      expect(await dispatchOf(job.id)).toMatchObject({ state: "acked" });
    } finally {
      await notReady.release();
    }
  });

  // #332-T03
  test("the Dispatcher is down when a job is queued: the sweep sends the call again when it is back and the review runs once", async ({
    page,
    request,
  }) => {
    const { number } = await openPullRequest(page, request, 20, "3");
    const job = await onlyJobOf(REPOSITORY.fullName, number);
    await waitForFailedSend(job.id);
    const run = runsOf(page, REPOSITORY.fullName, number);
    expect(await dispatchOf(job.id)).toMatchObject({
      state: "pending",
      lastStatus: null,
    });
    expect((await onlyJobOf(REPOSITORY.fullName, number)).status).toBe(
      "queued",
    );

    await startDispatcher();
    // After four failures the app waits five minutes; the cron comes by after that.
    await letTimePass(job.id, 310);
    const swept = await runSweep(request);

    expect(swept.sent).toBe(1);
    await page.reload();
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    // The cron comes by again and the app sends nothing: the job is done, and one Worker ran, once.
    expect((await runSweep(request)).sent).toBe(0);
    expect(theDispatcher().workersOf(job.id)).toHaveLength(1);
    expect(fakeLlm().requests()).toHaveLength(1);
    expect(
      await getPullRequestComments(request, REPOSITORY.fullName, number),
    ).toHaveLength(1);
    expect(await dispatchOf(job.id)).toMatchObject({
      state: "acked",
      lastStatus: 202,
    });
  });

  // #332-T04
  test("the Dispatcher stays down past the give-up: the run fails with dispatch_unavailable, the page says what that means, and the next push is reviewed", async ({
    page,
    request,
  }) => {
    const { number } = await openPullRequest(page, request, 21, "4");
    const job = await onlyJobOf(REPOSITORY.fullName, number);
    await waitForFailedSend(job.id);

    // An hour without a claim (the app's give-up is 60 minutes in a deployment).
    await letTimePass(job.id, 3700);
    const swept = await runSweep(request);

    expect(swept.givenUp).toBe(1);
    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "failed",
      errorCode: "dispatch_unavailable",
      attempts: 0,
    });
    await page.reload();
    const run = runsOf(page, REPOSITORY.fullName, number);
    await expect(run.locator("[data-status]")).toContainText("Failed");
    await run
      .getByRole("link", {
        name: `${REPOSITORY.fullName} #${String(number)}`,
      })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("dispatch_unavailable")).toBeVisible();
    await expect(
      detail.getByText(
        "No worker picked up this run within the time limit, so it was stopped.",
      ),
    ).toBeVisible();
    expect(fakeLlm().requests()).toHaveLength(0);

    // The pull request is free: the Dispatcher is back, a push is reviewed.
    await startDispatcher();
    const pushed = headSha("5", number);
    await addGithubPullRequest(request, REPOSITORY.fullName, {
      number,
      title: `Pull request ${String(number)}`,
      headSha: pushed,
    });
    await deliverPullRequestEvent(request, {
      action: "synchronize",
      installationId: INSTALLATION_ID,
      repository: { ...REPOSITORY, owner: OWNER_OF_REPOSITORY },
      number,
      title: `Pull request ${String(number)}`,
      headSha: pushed,
    });
    // A push is reviewed at once: the app sends the call when it queues the job, no sweep.
    await eventually(
      "the pushed commit to be reviewed",
      async () => {
        const comments = await getPullRequestComments(
          request,
          REPOSITORY.fullName,
          number,
        );
        return comments.some((comment) => comment.body.includes(REVIEW_MARKER));
      },
      120_000,
    );
    await eventually("the review to be reported", async () => {
      const states = await jobsOf(REPOSITORY.fullName, number);
      return states.every((item) => item.status !== "running");
    });
    expect(
      (await jobsOf(REPOSITORY.fullName, number)).map((item) => item.status),
    ).toEqual(["failed", "succeeded"]);
  });

  // #332-T05
  test("the platform refuses to create a sandbox: each refusal costs an attempt, the job is announced again, and after three the run fails with launch_failed without a Worker", async ({
    page,
    request,
  }) => {
    await startDispatcher();
    theDispatcher().failNextCreations(3);
    const { number } = await openPullRequest(page, request, 22, "6");
    const job = await onlyJobOf(REPOSITORY.fullName, number);

    // The first attempt came with the call the app sent when it queued the job. The Dispatcher gives the job back after
    // each refusal with a retry time of 30 seconds, and the app announces it again when that has passed (#395): no
    // sweep and no clock moved, three attempts in about a minute.
    await eventually(
      "the third launch to fail",
      async () => {
        return (
          (await onlyJobOf(REPOSITORY.fullName, number)).status === "failed"
        );
      },
      150_000,
    );

    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "failed",
      errorCode: "launch_failed",
    });
    expect(theDispatcher().workersOf(job.id)).toHaveLength(0);
    expect(fakeLlm().requests()).toHaveLength(0);
    await page.reload();
    const run = runsOf(page, REPOSITORY.fullName, number);
    await expect(run.locator("[data-status]")).toContainText("Failed");
    await run
      .getByRole("link", {
        name: `${REPOSITORY.fullName} #${String(number)}`,
      })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("launch_failed")).toBeVisible();
    await expect(
      detail.getByText(
        "The worker for this run could not be started, even after several tries.",
      ),
    ).toBeVisible();
  });

  // #487-T05
  test("a Worker that took over and keeps ending with an error: every lost lease costs an attempt, and after three the run fails with lease_expired and its copy", async ({
    page,
    request,
  }) => {
    await startDispatcher();
    theDispatcher().endWorkersWith(2);
    const { number } = await openPullRequest(page, request, 24, "8");
    const job = await onlyJobOf(REPOSITORY.fullName, number);

    // The Dispatcher does not watch a Worker after the hand-over: its end is not reported, the job stays running until the
    // lease (two minutes without a heartbeat) runs out. The clock of the job is moved and the app's own sweep ends the
    // lease, requeues the job and announces it again, three times.
    const launches = () =>
      theDispatcher().output().split(`"event":"launched","jobId":"${job.id}"`)
        .length - 1;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // The launch is over (the Worker took over) before the sweep announces the job again: a Dispatcher that is still
      // launching answers 429.
      await eventually(
        `Worker ${String(attempt)} to start and take over`,
        async () => {
          const state = await onlyJobOf(REPOSITORY.fullName, number);
          return (
            theDispatcher().workersOf(job.id).length === attempt &&
            launches() === attempt &&
            state.status === "running" &&
            state.attempts === attempt - 1
          );
        },
      );
      expect(theDispatcher().output()).not.toContain(
        '"reason":"worker_exited"',
      );
      await letTimePass(job.id, 150);
      await runSweep(request);
    }

    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      attempts: 3,
    });
    expect(theDispatcher().workersOf(job.id)).toHaveLength(3);
    expect(fakeLlm().requests()).toHaveLength(0);
    // The last lapsed lease ended the job for good, so the app told the Dispatcher to stop its VM (#487-T06). The two
    // lapsed leases before it only sent the job back to the queue, and nothing was stopped for them.
    await eventually("the app's stop for the failed job", async () => {
      return theDispatcher()
        .output()
        .includes(`"event":"stop_received","jobId":"${job.id}"`);
    });
    expect(
      theDispatcher()
        .output()
        .split(`"event":"stop_received","jobId":"${job.id}"`).length - 1,
    ).toBe(1);
    await page.reload();
    const run = runsOf(page, REPOSITORY.fullName, number);
    await expect(run.locator("[data-status]")).toContainText("Failed");
    await run
      .getByRole("link", {
        name: `${REPOSITORY.fullName} #${String(number)}`,
      })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("lease_expired")).toBeVisible();
    await expect(
      detail.getByText(
        "The runner stopped reporting while it worked on this run, and the run ran out of retries.",
      ),
    ).toBeVisible();
  });

  // #332-T06
  test("a Worker dies in the middle of a review: its lease runs out, the sweep puts the job back and a second Worker finishes it", async ({
    page,
    request,
  }) => {
    await startDispatcher();
    // The model does not answer until told to: the first Worker is inside its review when it dies.
    fakeLlm().hold(true);
    const { number } = await openPullRequest(page, request, 23, "7");
    const job = await onlyJobOf(REPOSITORY.fullName, number);
    await eventually("the first Worker to ask the model", async () => {
      return fakeLlm().requests().length === 1;
    });
    const first = required(
      theDispatcher().workersOf(job.id)[0],
      "The first Worker",
    );

    theDispatcher().killContainer(first);
    fakeLlm().hold(false);

    // Nobody watches the container: the job stays running until the lease runs out.
    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "running",
      attempts: 0,
    });
    expect(theDispatcher().output()).not.toContain('"reason":"worker_exited"');

    // Two minutes without a heartbeat: the cron sweep ends the lease and puts the job back.
    await letTimePass(job.id, 150);
    const swept = await runSweep(request);
    expect(swept.expired).toMatchObject({ requeued: 1 });

    const run = runsOf(page, REPOSITORY.fullName, number);
    await page.reload();
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(theDispatcher().workersOf(job.id)).toHaveLength(2);
    // The first Worker never published anything; the second one did, once.
    const comments = await getPullRequestComments(
      request,
      REPOSITORY.fullName,
      number,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.revision).toBe(1);
    expect(fakeLlm().requests()).toHaveLength(2);
  });
});
