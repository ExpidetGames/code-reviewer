// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createApp } from "../dispatcher-app.ts";
import { createBackgroundTracker } from "../test-support/background.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  settingsFor,
  signedRequest,
  startApp,
  webhookBody,
} from "../test-support/harness.ts";
import { webhookTrigger } from "../triggers/webhook.ts";
import { createCapabilityProbe, ProbeRunError } from "./capability-probe.ts";
import { withProbeEndpoint } from "./probe-endpoint.ts";

const NOW = 1_791_633_600;
const PASSING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;
const DENYING = `${JSON.stringify({ version: 1, engines: ["pr-agent"], reasons: ["root_filesystem_writable"] })}\n`;

let fake: DispatcherAppFake;
beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await fake.close();
});

type Run = (call: number) => Promise<string>;

function setup(run: Run) {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const background = createBackgroundTracker();
  let calls = 0;
  const probe = createCapabilityProbe({
    run: () => {
      calls += 1;
      return run(calls);
    },
    clock,
    now: () => clock.now(),
    logger,
  });
  const base = createFakeLauncher({ engines: ["pr-agent", "opencode"] });
  const launcher = withProbeEndpoint({ launcher: base, probe });
  const signal = new AbortController().signal;
  return {
    clock,
    logger,
    background,
    launcher,
    base,
    signal,
    calls: () => calls,
  };
}

describe("the probe endpoint of a Launcher (#479)", () => {
  // #479-T04
  it("leaves capabilities and launch to the Launcher underneath: no probe is run for either", async () => {
    const { launcher, base, signal, calls } = setup(() =>
      Promise.resolve(DENYING),
    );
    const spec = {
      appUrl: "http://app.invalid",
      jobId: "job",
      credential: "dummy",
      kind: "dynamic" as const,
      timeoutSeconds: 60,
      config: {},
    };

    expect(await launcher.capabilities(signal)).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    await launcher.launch(spec, signal);

    expect(base.launches).toStrictEqual([spec]);
    expect(calls()).toBe(0);
  });

  // #331-T05
  it("forces a probe on request and reports it with the time", async () => {
    const { launcher, signal, calls, clock } = setup(() =>
      Promise.resolve(PASSING),
    );
    await clock.advance(61_000);

    const report = await launcher.probe?.(signal);

    expect(calls()).toBe(1);
    expect(report).toStrictEqual({
      status: "passed",
      engines: ["pr-agent", "opencode"],
      reasons: [],
      // The probe's clock is epoch milliseconds; the test's starts at 0 and has moved 61 seconds.
      checkedAt: "1970-01-01T00:01:01.000Z",
    });
  });

  // #331-T06
  it("shares one probe between concurrent forced probes", async () => {
    let finish: (stdout: string) => void = () => undefined;
    const { launcher, signal, calls } = setup(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const forced = [launcher.probe?.(signal), launcher.probe?.(signal)];
    await settle();
    finish(PASSING);
    await Promise.all(forced);

    expect(calls()).toBe(1);
  });

  // #331-T02
  it("reports a failed probe with its stable code and PR-Agent only", async () => {
    const { launcher, signal } = setup(() =>
      Promise.reject(new ProbeRunError("sandbox_quota_exceeded")),
    );

    expect(await launcher.probe?.(signal)).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: "sandbox_quota_exceeded",
    });
  });
});

describe("a Dispatcher with a probe endpoint, against the fake App (#479)", () => {
  function dispatcher(run: Run) {
    const parts = setup(run);
    const app = createApp({
      settings: settingsFor(fake.url),
      launcher: parts.launcher,
      logger: parts.logger,
      background: parts.background.run,
      trigger: webhookTrigger({
        keys: [{ kid: KEY_ID, secret: SIGNING_SECRET }],
        nowSeconds: () => NOW,
      }),
    });
    const call = (jobId: string, reviewKind: "diff" | "dynamic") =>
      app.fetch(
        signedRequest({
          body: webhookBody({ jobId, reviewKind }),
          nowSeconds: NOW,
        }),
      );
    return { ...parts, app, call };
  }

  // #479-T04
  it("accepts a Dynamic job at once on a fresh instance and starts no canary VM", async () => {
    const dynamicJob = fake.enqueue({ reviewKind: "dynamic" });
    const { call, background, base, calls, clock } = dispatcher(() =>
      Promise.resolve(PASSING),
    );

    const accepted = await call(dynamicJob, "dynamic");
    await background.drain(1000);

    expect(accepted.status).toBe(202);
    expect(base.launches.map((spec) => [spec.jobId, spec.kind])).toStrictEqual([
      [dynamicJob, "dynamic"],
    ]);
    // No probe was run and none is waiting on the clock: the first call did not wait for a proof.
    expect(calls()).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  // #479-T05
  it("accepts concurrent Dynamic jobs on a fresh instance without a probe between them", async () => {
    const jobs = [
      fake.enqueue({ reviewKind: "dynamic" }),
      fake.enqueue({ reviewKind: "dynamic" }),
      fake.enqueue({ reviewKind: "dynamic" }),
    ];
    const { call, background, base, calls } = dispatcher(() =>
      Promise.resolve(PASSING),
    );

    const answers = await Promise.all(jobs.map((job) => call(job, "dynamic")));
    await background.drain(1000);

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      202, 202, 202,
    ]);
    expect(base.launches).toHaveLength(3);
    expect(calls()).toBe(0);
  });

  // #479-T06
  it("does not answer 503 for a probe on the way: a Dynamic job has no such answer any more", async () => {
    const dynamicJob = fake.enqueue({ reviewKind: "dynamic" });
    const { call, background, logger } = dispatcher(() =>
      Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );

    const answer = await call(dynamicJob, "dynamic");
    await background.drain(1000);

    expect(answer.status).toBe(202);
    expect(answer.headers.get("retry-after")).toBeNull();
    expect(logger.text()).not.toContain("capabilities_pending");
  });

  // #331-T05
  it("serves /probe with the dispatcher credential and runs the probe there", async () => {
    const { app, calls } = dispatcher(() => Promise.resolve(DENYING));

    const response = await app.fetch(
      new Request("http://dispatcher.test/probe", {
        method: "POST",
        headers: { authorization: `Bearer ${DISPATCHER_TOKEN}` },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "denied",
      ok: false,
      reasons: ["root_filesystem_writable"],
    });
    expect(calls()).toBe(1);
  });

  // #331-T05
  it("serves /probe from a passing canary with 200", async () => {
    const { app, calls } = dispatcher(() => Promise.resolve(PASSING));

    const response = await app.fetch(
      new Request("http://dispatcher.test/probe", {
        method: "POST",
        headers: { authorization: `Bearer ${DISPATCHER_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "passed",
      ok: true,
    });
    expect(calls()).toBe(1);
  });
});
