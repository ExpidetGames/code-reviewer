// SPDX-License-Identifier: Apache-2.0

// The stop route in the composed Dispatcher (#487): it is mounted with the signing keys of the deployment and the
// platform's fleet when there is a golden snapshot (the same condition as the reaper), and does not exist otherwise.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { composeDispatcher } from "../compose.ts";
import { noLauncher } from "../launchers/none.ts";
import {
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  signedStopRequest,
  stopBody,
} from "../test-support/harness.ts";

const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";
const ENV = {
  RUNNER_API_URL: "http://127.0.0.1:9",
  RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: KEY_ID,
  DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
};

describe("the stop route of a composed Dispatcher", () => {
  // #487-T01
  it("stops the VM of the job through the deployment's fleet when a snapshot is configured", async () => {
    const sandbox = new FakeSandboxService();
    const pending: Promise<unknown>[] = [];
    const name = `cr-diff-${JOB}-abcd1234`;
    sandbox.seedVm({
      name,
      tags: { app: "code-reviewer", kind: "diff", job: JOB },
      createdAtMs: Date.now() - 600_000,
    });
    const { app } = composeDispatcher({
      env: ENV,
      launcher: noLauncher,
      background: (work) => pending.push(work),
      reaper: () => ({
        fleet: sandbox,
        jobLifetimeSeconds: 1500,
        canaryLifetimeSeconds: 450,
      }),
      logger: recordingLogger(),
    });

    const response = await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );

    expect(response.status).toBe(202);
    await Promise.all(pending);
    expect(sandbox.stops).toStrictEqual([name]);
  });

  // #487-T10
  it("does not exist without a fleet: the answer is the 404 of a Dispatcher of an earlier release", async () => {
    const { app } = composeDispatcher({
      env: ENV,
      launcher: noLauncher,
      background: () => undefined,
      logger: recordingLogger(),
    });

    const response = await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );

    expect(response.status).toBe(404);
  });
});
