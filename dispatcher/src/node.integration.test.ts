// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../fakes/dispatcher-app/server.ts";
import { FakeSandboxService } from "../../fakes/sandbox/service.ts";
import { createFakeLauncher } from "./launchers/fake.ts";
import { startNodeServer, type NodeServer } from "./node.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  signedRequest,
  signedStopRequest,
  startApp,
  stopBody,
  waitFor,
  webhookBody,
} from "./test-support/harness.ts";

let fake: DispatcherAppFake;
let server: NodeServer | undefined;

beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await server?.shutdown();
  server = undefined;
  await fake.close();
});

function environment(): Record<string, string> {
  return {
    RUNNER_API_URL: fake.url,
    RUNNER_TOKEN: DISPATCHER_TOKEN,
    DISPATCHER_MAX_RUNNING: "2",
    DISPATCHER_SIGNING_KEY_ID: KEY_ID,
    DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
  };
}

async function post(port: number, request: Request): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: request.headers,
    body: await request.text(),
  });
}

describe("the Node entry against the fake App", () => {
  // #327-T11
  it("serves /health and /dispatch over HTTP and starts the Worker for a signed call", async () => {
    const jobId = fake.enqueue();
    const launcher = createFakeLauncher();
    server = await startNodeServer({
      env: environment(),
      launcher,
      port: 0,
      logger: recordingLogger(),
    });

    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    const response = await post(
      server.port,
      signedRequest({
        body: webhookBody({ jobId }),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );
    await waitFor(() => launcher.launches.length === 1, "the launch");

    expect(health.status).toBe(200);
    expect(response.status).toBe(202);
    expect(launcher.launches[0]).toMatchObject({ jobId, appUrl: fake.url });
  });

  // #487-T01
  it("serves /stop over HTTP when the entry is given a fleet, and drains the stop before it shuts down", async () => {
    const jobId = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";
    const sandbox = new FakeSandboxService();
    const name = `cr-diff-${jobId}-abcd1234`;
    sandbox.seedVm({
      name,
      tags: { app: "code-reviewer", kind: "diff", job: jobId },
      createdAtMs: Date.now() - 600_000,
    });
    server = await startNodeServer({
      env: environment(),
      launcher: createFakeLauncher(),
      port: 0,
      logger: recordingLogger(),
      reaper: () => ({
        fleet: sandbox,
        jobLifetimeSeconds: 1500,
        canaryLifetimeSeconds: 450,
      }),
    });
    const call = signedStopRequest({
      body: stopBody({ jobId }),
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/stop`, {
      method: "POST",
      headers: call.headers,
      body: await call.text(),
    });

    expect(response.status).toBe(202);
    await server.shutdown();
    expect(sandbox.stops).toStrictEqual([name]);
  });

  // #327-T11
  it("shuts down gracefully: stops accepting, waits for the launch in progress, then closes", async () => {
    const jobId = fake.enqueue();
    let finishLaunch: () => void = () => undefined;
    const launcher = createFakeLauncher({
      onLaunch: () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    });
    const logger = recordingLogger();
    const started = await startNodeServer({
      env: environment(),
      launcher,
      port: 0,
      logger,
    });
    server = started;
    await post(
      started.port,
      signedRequest({
        body: webhookBody({ jobId }),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );
    await waitFor(() => launcher.launches.length === 1, "the launch");

    let closed = false;
    const shutdown = started.shutdown().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${started.port}/health`),
    ).rejects.toThrow();
    finishLaunch();
    await shutdown;

    expect(closed).toBe(true);
    expect(fake.requests().filter((r) => r.route === "release")).toStrictEqual(
      [],
    );
    expect(logger.text()).toContain("shutdown");
  });

  // #327-T11
  it("gives a launch that outlasts the grace period back to the app with a release", async () => {
    const jobId = fake.enqueue();
    const launcher = createFakeLauncher({
      onLaunch: (_spec, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        ),
    });
    const started = await startNodeServer({
      env: { ...environment(), DISPATCHER_SHUTDOWN_GRACE_SECONDS: "1" },
      launcher,
      port: 0,
      logger: recordingLogger(),
    });
    await post(
      started.port,
      signedRequest({
        body: webhookBody({ jobId }),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );
    await waitFor(() => launcher.launches.length === 1, "the launch");

    await started.shutdown();

    expect(fake.requests().filter((r) => r.route === "release")).toHaveLength(
      1,
    );
  });

  // #327-T11
  it("can be shut down twice", async () => {
    server = await startNodeServer({
      env: environment(),
      launcher: createFakeLauncher(),
      port: 0,
      logger: recordingLogger(),
    });

    await server.shutdown();
    await expect(server.shutdown()).resolves.toBeUndefined();
  });
});
