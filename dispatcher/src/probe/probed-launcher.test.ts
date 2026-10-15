// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createApp } from "../app.ts";
import { createBackgroundTracker } from "../background.ts";
import { CapabilitiesPending } from "../core/types.ts";
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
import { withCapabilityProbe } from "./probed-launcher.ts";

const HOUR = 60 * 60_000;
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

function setup(
  run: Run,
  baseEngines: ("pr-agent" | "opencode")[] = ["pr-agent"],
) {
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
  const base = createFakeLauncher({ engines: baseEngines });
  const launcher = withCapabilityProbe({
    launcher: base,
    probe,
    background: background.run,
  });
  const signal = new AbortController().signal;
  return {
    clock,
    logger,
    background,
    launcher,
    base,
    signal,
    probe,
    calls: () => calls,
  };
}

describe("a Launcher behind the capability probe", () => {
  // #331-T01
  it("advertises opencode once a fresh probe passed, and keeps PR-Agent", async () => {
    const { launcher, signal, probe } = setup(() => Promise.resolve(PASSING));
    await probe.refresh();

    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(await launcher.capabilities(signal)).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(await launcher.capabilities(signal, "pr-agent")).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #331-T02
  it("does not advertise opencode when the probe left it out, but keeps PR-Agent", async () => {
    const { launcher, signal, probe } = setup(() => Promise.resolve(DENYING));
    await probe.refresh();

    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
    ]);
    expect(await launcher.capabilities(signal)).toStrictEqual(["pr-agent"]);
  });

  // #331-T02
  it("does not advertise opencode when the probe could not run", async () => {
    const { launcher, signal, probe } = setup(() =>
      Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );
    await probe.refresh();

    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #331-T02
  it("never takes opencode from the Launcher underneath: only a probe can prove it", async () => {
    const { launcher, signal, probe } = setup(
      () => Promise.resolve(DENYING),
      ["pr-agent", "opencode"],
    );
    await probe.refresh();

    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #331-T01
  it("starts the probe in the background and asks to be asked again while a Dynamic job waits for the proof", async () => {
    let finish: (stdout: string) => void = () => undefined;
    const { launcher, signal, background, calls } = setup(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const first = launcher.capabilities(signal, "opencode");
    await expect(first).rejects.toBeInstanceOf(CapabilitiesPending);
    await expect(
      launcher.capabilities(signal, "opencode"),
    ).rejects.toBeInstanceOf(CapabilitiesPending);
    await settle();

    expect(calls()).toBe(1);
    finish(PASSING);
    await background.drain(1000);
    expect(await launcher.capabilities(signal, "opencode")).toContain(
      "opencode",
    );
    expect(calls()).toBe(1);
  });

  // #331-T01
  it("does not make a Diff job wait for the probe, and does not start one for it", async () => {
    const { launcher, signal, calls } = setup(() => Promise.resolve(PASSING));

    expect(await launcher.capabilities(signal, "pr-agent")).toStrictEqual([
      "pr-agent",
    ]);

    expect(calls()).toBe(0);
  });

  // #331-T02
  it("advertises PR-Agent only for a call that wants nothing in particular while the probe is on its way", async () => {
    const { launcher, signal, background, calls } = setup(() =>
      Promise.resolve(PASSING),
    );

    expect(await launcher.capabilities(signal)).toStrictEqual(["pr-agent"]);
    await background.drain(1000);

    expect(calls()).toBe(1);
    expect(await launcher.capabilities(signal)).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
  });

  // #331-T03
  it("asks for the proof again when it is older than its time to live, and takes opencode away meanwhile", async () => {
    let finish: (stdout: string) => void = () => undefined;
    const { launcher, signal, clock, background, calls } = setup((call) =>
      call === 1
        ? Promise.resolve(PASSING)
        : new Promise<string>((resolve) => {
            finish = resolve;
          }),
    );
    await launcher.capabilities(signal, "opencode").catch(() => undefined);
    await background.drain(1000);
    expect(await launcher.capabilities(signal, "opencode")).toContain(
      "opencode",
    );

    await clock.advance(HOUR + 1000);

    await expect(
      launcher.capabilities(signal, "opencode"),
    ).rejects.toBeInstanceOf(CapabilitiesPending);
    expect(await launcher.capabilities(signal)).toStrictEqual(["pr-agent"]);
    expect(calls()).toBe(2);
    finish(PASSING);
    await background.drain(1000);
    expect(await launcher.capabilities(signal, "opencode")).toContain(
      "opencode",
    );
    expect(calls()).toBe(2);
  });

  // #331-T04
  it("restores opencode when a probe that failed is repeated and passes", async () => {
    const { launcher, signal, clock, background } = setup((call) =>
      call === 1
        ? Promise.reject(new ProbeRunError("sandbox_network"))
        : Promise.resolve(PASSING),
    );
    await launcher.capabilities(signal, "opencode").catch(() => undefined);
    await background.drain(1000);
    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
    ]);

    await clock.advance(61_000);
    await launcher.capabilities(signal, "opencode").catch(() => undefined);
    await background.drain(1000);

    expect(await launcher.capabilities(signal, "opencode")).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
  });

  // #331-T01
  it("hands every launch to the Launcher underneath", async () => {
    const { launcher, base, signal } = setup(() => Promise.resolve(PASSING));
    const spec = {
      appUrl: "http://app.invalid",
      jobId: "job",
      credential: "dummy",
      kind: "diff" as const,
      timeoutSeconds: 60,
      config: {},
    };

    await launcher.launch(spec, signal);

    expect(base.launches).toStrictEqual([spec]);
  });

  // #331-T05
  it("forces a probe on request, whatever the age of the last one, and reports it with the time", async () => {
    const { launcher, signal, probe, calls } = setup(() =>
      Promise.resolve(PASSING),
    );
    await probe.refresh();

    const report = await launcher.probe?.(signal);

    expect(calls()).toBe(2);
    expect(report).toStrictEqual({
      status: "passed",
      engines: ["pr-agent", "opencode"],
      reasons: [],
      // The probe's clock is epoch milliseconds; the test's starts at 0.
      checkedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  // #331-T06
  it("shares one probe between a forced probe and the wake-up calls that wait for it", async () => {
    let finish: (stdout: string) => void = () => undefined;
    const { launcher, signal, calls } = setup(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const forced = [launcher.probe?.(signal), launcher.probe?.(signal)];
    await launcher.capabilities(signal, "opencode").catch(() => undefined);
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

describe("a Dispatcher behind the capability probe, against the fake App", () => {
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

  // #331-T07
  it("leaves a Dynamic job queued, unclaimed, when the probe fails, and still runs a Diff job", async () => {
    const dynamicJob = fake.enqueue({ reviewKind: "dynamic" });
    const diffJob = fake.enqueue();
    const { call, background, base, calls } = dispatcher(() =>
      Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );

    // The first call finds no proof: it starts the probe and asks to be asked again.
    const waiting = await call(dynamicJob, "dynamic");
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("retry-after")).toMatch(/^\d+$/);
    await background.drain(1000);
    // The probe failed: PR-Agent only, so the Dynamic job is not capable here.
    const refused = await call(dynamicJob, "dynamic");
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({
      status: "ignored",
      reason: "not_capable",
    });

    const diff = await call(diffJob, "diff");
    expect(diff.status).toBe(202);
    await background.drain(1000);

    expect(
      fake
        .requests()
        .filter((r) => r.route === "claim" && r.jobId === dynamicJob),
    ).toStrictEqual([]);
    expect(base.launches.map((spec) => spec.jobId)).toStrictEqual([diffJob]);
    expect(calls()).toBe(1);
  });

  // #331-T01
  it("claims and launches a Dynamic job once the probe passed", async () => {
    const dynamicJob = fake.enqueue({ reviewKind: "dynamic" });
    const { call, background, base } = dispatcher(() =>
      Promise.resolve(PASSING),
    );

    expect((await call(dynamicJob, "dynamic")).status).toBe(503);
    await background.drain(1000);
    const accepted = await call(dynamicJob, "dynamic");
    await background.drain(1000);

    expect(accepted.status).toBe(202);
    expect(base.launches.map((spec) => [spec.jobId, spec.kind])).toStrictEqual([
      [dynamicJob, "dynamic"],
    ]);
  });

  // #331-T05
  it("serves /probe with the dispatcher credential and runs the same shared probe", async () => {
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
});
