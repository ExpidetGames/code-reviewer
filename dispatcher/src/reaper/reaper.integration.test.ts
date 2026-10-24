// SPDX-License-Identifier: LicenseRef-Proprietary

// The reaper through the composed Dispatcher: the cron route over HTTP-shaped requests, the real App client talking to the
// fake App over loopback, and the fake Sandbox service. No real platform: nothing here reaches the internet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { composeDispatcher } from "../compose.ts";
import { noLauncher } from "../launchers/none.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  startApp,
} from "../test-support/harness.ts";
import { REAP_PATH } from "./route.ts";

const CRON_SECRET = "a-cron-secret-of-at-least-32-characters";
const JOB_ENDED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_RUNNING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_QUEUED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MINUTE = 60_000;

let app: DispatcherAppFake;

beforeEach(async () => {
  app = await startApp();
});
afterEach(async () => {
  await app.close();
});

function compose(sandbox: FakeSandboxService) {
  const logger = recordingLogger();
  const { app: dispatcher } = composeDispatcher({
    env: {
      RUNNER_API_URL: app.url,
      RUNNER_TOKEN: DISPATCHER_TOKEN,
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: KEY_ID,
      DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      CRON_SECRET,
    },
    launcher: noLauncher,
    background: () => undefined,
    reaper: () => ({
      fleet: sandbox,
      jobLifetimeSeconds: 1500,
      canaryLifetimeSeconds: 450,
    }),
    logger,
  });
  const reap = () =>
    dispatcher.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
  return { reap, logger };
}

function jobVm(sandbox: FakeSandboxService, jobId: string, ageMs: number) {
  const name = `cr-diff-${jobId}-abcd1234`;
  sandbox.seedVm({
    name,
    tags: { app: "code-reviewer", kind: "diff", job: jobId },
    createdAtMs: Date.now() - ageMs,
  });
  return name;
}

describe("the reaper route against the fake App and the fake Sandbox service", () => {
  // #364-T23
  it("stops the VM of a finished job and of a job that waits again, keeps the VM of a running job and leaves a foreign VM", async () => {
    const sandbox = new FakeSandboxService();
    for (const id of [JOB_ENDED, JOB_RUNNING, JOB_QUEUED]) app.enqueue({ id });
    app.setJobStatus(JOB_ENDED, "failed");
    app.setJobStatus(JOB_RUNNING, "running");
    const ended = jobVm(sandbox, JOB_ENDED, 10 * MINUTE);
    const running = jobVm(sandbox, JOB_RUNNING, 10 * MINUTE);
    const queued = jobVm(sandbox, JOB_QUEUED, 10 * MINUTE);
    sandbox.seedVm({
      name: "somebody-elses-vm",
      tags: { owner: "somebody" },
      createdAtMs: Date.now() - 10 * 3600 * 1000,
    });
    const t = compose(sandbox);

    const response = await t.reap();

    expect(response.status).toBe(200);
    expect([...sandbox.stops].sort()).toStrictEqual([ended, queued].sort());
    expect(sandbox.stops).not.toContain(running);
    expect(sandbox.stops).not.toContain("somebody-elses-vm");
    expect(await response.json()).toMatchObject({
      status: "ok",
      candidates: 3,
      stopped: 2,
      kept: 1,
    });
    // The App was only ever asked for the state of the jobs, with the dispatcher credential.
    const calls = app.requests();
    expect(calls.map((call) => call.route)).toStrictEqual([
      "job_state",
      "job_state",
      "job_state",
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(t.logger.text()).not.toContain(DISPATCHER_TOKEN);
    expect(t.logger.text()).not.toContain(CRON_SECRET);
  });

  // #487-T10
  it("still ends the VM of a finished job when the App never sends the stop call, as an App of the previous release does", async () => {
    const sandbox = new FakeSandboxService();
    app.enqueue({ id: JOB_ENDED });
    app.setJobStatus(JOB_ENDED, "succeeded");
    const lingering = jobVm(sandbox, JOB_ENDED, 10 * MINUTE);
    const t = compose(sandbox);

    const response = await t.reap();

    expect(response.status).toBe(200);
    expect(sandbox.stops).toStrictEqual([lingering]);
    expect(t.logger.text()).not.toContain("stop_received");
  });

  // #364-T27
  it("falls back to the lifetime when the App cannot be read: a young VM stays, an overdue one goes", async () => {
    const sandbox = new FakeSandboxService();
    app.enqueue({ id: JOB_ENDED });
    app.enqueue({ id: JOB_RUNNING });
    app.setJobStatus(JOB_ENDED, "failed");
    // An App of a previous release has no such route (404) and a broken one answers 500: neither is a state.
    app.script("job_state", [{ status: 404 }]);
    const young = jobVm(sandbox, JOB_ENDED, 10 * MINUTE);
    const overdue = jobVm(sandbox, JOB_RUNNING, (1500 + 121) * 1000);
    const t = compose(sandbox);

    const response = await t.reap();

    expect(await response.json()).toMatchObject({
      stopped: 1,
      kept: 1,
      unreadable: 1,
    });
    expect(sandbox.stops).toStrictEqual([overdue]);
    expect(sandbox.stops).not.toContain(young);
  });

  // #364-T29
  it("stops an expired canary and a leftover job VM and nothing of the golden snapshot's, whatever its age", async () => {
    const sandbox = new FakeSandboxService();
    app.enqueue({ id: JOB_ENDED });
    app.setJobStatus(JOB_ENDED, "succeeded");
    const job = jobVm(sandbox, JOB_ENDED, 10 * MINUTE);
    const canary = "cr-canary-0badf00d";
    sandbox.seedVm({
      name: canary,
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: Date.now() - (450 + 121) * 1000,
    });
    const freshCanary = "cr-canary-0badf00e";
    sandbox.seedVm({
      name: freshCanary,
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: Date.now() - 60 * 1000,
    });
    for (const [name, role] of [
      ["code-reviewer-golden-builder-20260101t000000z", "golden-builder"],
      ["code-reviewer-golden-check-20260101t000000z", "golden-check"],
    ] as const)
      sandbox.seedVm({
        name,
        tags: { app: "code-reviewer", role },
        createdAtMs: Date.now() - 48 * 3600 * 1000,
      });
    const t = compose(sandbox);

    const response = await t.reap();

    expect(response.status).toBe(200);
    expect([...sandbox.stops].sort()).toStrictEqual([canary, job].sort());
    expect(sandbox.stops.some((name) => name.includes("golden"))).toBe(false);
    expect(sandbox.stops).not.toContain(freshCanary);
    // The canary has no job: the App was asked about the one job only.
    expect(app.requests()).toHaveLength(1);
    expect(app.requests()[0]?.jobId).toBe(JOB_ENDED);
  });

  // #364-T09
  it("retries a stop that failed in the next run", async () => {
    const sandbox = new FakeSandboxService();
    app.enqueue({ id: JOB_ENDED });
    app.setJobStatus(JOB_ENDED, "cancelled");
    const name = jobVm(sandbox, JOB_ENDED, 10 * MINUTE);
    sandbox.failStops(new Error("dummy platform failure"), name);
    const t = compose(sandbox);

    const first = await (await t.reap()).json();
    sandbox.healStops();
    const second = await (await t.reap()).json();

    expect(first).toMatchObject({ stopped: 0, failed: 1 });
    expect(second).toMatchObject({ stopped: 1, failed: 0 });
    expect(sandbox.stops).toStrictEqual([name, name]);
    expect(sandbox.running()).toStrictEqual([]);
  });

  // #364-T16
  it("warns once at start when CRON_SECRET is missing, and refuses every caller", async () => {
    const sandbox = new FakeSandboxService();
    const logger = recordingLogger();
    const { app: dispatcher } = composeDispatcher({
      env: {
        RUNNER_API_URL: app.url,
        RUNNER_TOKEN: DISPATCHER_TOKEN,
        DISPATCHER_MAX_RUNNING: "2",
        DISPATCHER_SIGNING_KEY_ID: KEY_ID,
        DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      },
      launcher: noLauncher,
      background: () => undefined,
      reaper: () => ({
        fleet: sandbox,
        jobLifetimeSeconds: 1500,
        canaryLifetimeSeconds: 450,
      }),
      logger,
    });

    const response = await dispatcher.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(401);
    expect(logger.text()).toContain("reaper_cron_secret_missing");
    expect(sandbox.lists).toStrictEqual([]);
  });
});
