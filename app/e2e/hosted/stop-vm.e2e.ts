// SPDX-License-Identifier: LicenseRef-Proprietary

// The VM of a finished job is stopped on the App's signal (#487-T09), with the real app (serverless mode, Postgres), the real
// Dispatcher and the real Worker on fakes. The Dispatcher holds no supervision after the hand-over: when the job's claim
// ends the app sends a signed `POST /stop`, and the Dispatcher stops the VMs tagged with that job (the Sandbox double's
// `list` and `stop`, as the deployment does through the platform). The journey shows both halves: while the Worker is
// inside its review nothing is stopped, and after the result the App's call ends the VM. A Dynamic job is stopped the same
// way (the stop is scoped by the job's tag, not by its kind); the privileged lane has no Dispatcher process, so the
// journey runs a Diff job.
import { expect, test } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv } from "../helpers/e2e-env";
import { addGithubPullRequest } from "../helpers/github-fake";
import { onlyJobOf } from "../helpers/hosted-db";
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
  headSha,
  openRuns,
  RUN_TIMEOUT,
  runsOf,
} from "../helpers/hosted-journey";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const INSTALLATION_ID = 9500306;
const REPOSITORY = { id: 9700006, fullName: "hosted-stop/widgets" };
const OWNER_OF_REPOSITORY = { login: "hosted-stop", id: OWNER.id };

/** The structured log lines of the Dispatcher about one job, by event name. */
function eventsOf(output: string, jobId: string): string[] {
  const events: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as { event?: string; jobId?: string };
      if (entry.jobId === jobId && entry.event !== undefined)
        events.push(entry.event);
    } catch {
      // Not a log line of ours.
    }
  }
  return events;
}

test.describe.configure({ mode: "serial" });

test.describe("the VM of a finished job is stopped by the App's signal", () => {
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

  // #487-T09
  test("nothing is stopped while the Worker reviews, and the App's call after its result stops the job's VM", async ({
    page,
    request,
  }) => {
    const number = 31;
    const head = headSha("c", number);
    await addGithubPullRequest(request, REPOSITORY.fullName, {
      number,
      title: "Add a stop helper",
      headSha: head,
    });
    await openRuns(page);
    // The model does not answer until told to: the Worker is inside its review, the VM is in use.
    fakeLlm().hold(true);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...REPOSITORY, owner: OWNER_OF_REPOSITORY },
      number,
      title: "Add a stop helper",
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
    const job = await onlyJobOf(REPOSITORY.fullName, number);
    await eventually("the Worker to ask the model", async () => {
      return fakeLlm().requests().length === 1;
    });
    // The hand-over is past (the lane's is one second) and the Dispatcher holds nothing: it logs no wait and no stop.
    await eventually("the hand-over", async () => {
      return eventsOf(theDispatcher().output(), job.id).includes("launched");
    });
    expect(eventsOf(theDispatcher().output(), job.id)).not.toContain(
      "stop_received",
    );
    expect(await onlyJobOf(REPOSITORY.fullName, number)).toMatchObject({
      status: "running",
    });

    fakeLlm().hold(false);
    const run = runsOf(page, REPOSITORY.fullName, number);
    await page.reload();
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    // The result ended the claim; the App told the Dispatcher after its response, and the VM of this job was stopped.
    await eventually("the Dispatcher to stop the job's VM", async () => {
      return eventsOf(theDispatcher().output(), job.id).includes("vm_stopped");
    });
    const events = eventsOf(theDispatcher().output(), job.id);
    expect(events.filter((event) => event === "stop_received")).toHaveLength(1);
    expect(events).not.toContain("stop_refused");
    expect(events).not.toContain("vm_stop_failed");
    expect(events).not.toContain("worker_exited");
    expect(theDispatcher().output()).toContain(
      `"event":"stop_received","jobId":"${job.id}","vms":1`,
    );
  });
});
