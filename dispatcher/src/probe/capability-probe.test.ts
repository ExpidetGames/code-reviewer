// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import { recordingLogger } from "../test-support/harness.ts";
import {
  createCapabilityProbe,
  ProbeRunError,
  type ProbeRunner,
} from "./capability-probe.ts";

const MINUTE = 60_000;

const PASSING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;
const DENYING = `${JSON.stringify({ version: 1, engines: ["pr-agent"], reasons: ["ipv6_not_disabled"] })}\n`;

type Script = (call: number, signal: AbortSignal) => Promise<string>;

function setup(
  script: Script,
  options: {
    timeoutMs?: number;
    forceReuseMs?: number;
    abortGraceMs?: number;
  } = {},
) {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const calls: AbortSignal[] = [];
  const run: ProbeRunner = (signal) => {
    calls.push(signal);
    return script(calls.length, signal);
  };
  const probe = createCapabilityProbe({
    run,
    clock,
    now: () => clock.now(),
    logger,
    ...options,
  });
  return { clock, logger, calls, probe };
}

describe("the capability probe", () => {
  // #331-T01
  it("proves opencode from a passing verdict", async () => {
    const { probe, calls } = setup(() => Promise.resolve(PASSING));

    const outcome = await probe.refresh();

    expect(outcome).toMatchObject({
      status: "passed",
      engines: ["pr-agent", "opencode"],
      reasons: [],
    });
    expect(calls).toHaveLength(1);
  });

  // #331-T02
  it("advertises PR-Agent only when the container's verdict leaves opencode out, with its reasons", async () => {
    const { probe, logger } = setup(() => Promise.resolve(DENYING));

    const outcome = await probe.refresh();

    expect(outcome).toMatchObject({
      status: "denied",
      engines: ["pr-agent"],
      reasons: ["ipv6_not_disabled"],
    });
    expect(logger.text()).toContain("ipv6_not_disabled");
  });

  // #331-T02
  it("advertises PR-Agent only when no probe can be run, with a stable code", async () => {
    const { probe, logger } = setup(() =>
      Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );

    const outcome = await probe.refresh();

    expect(outcome).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: "sandbox_unavailable",
    });
    expect(logger.text()).toContain("sandbox_unavailable");
  });

  // #331-T02
  it("fails closed with probe_unreadable when the output is not a verdict", async () => {
    const { probe } = setup(() => Promise.resolve("opencode: yes\n"));

    expect(await probe.refresh()).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
      failure: "probe_unreadable",
    });
  });

  // #331-T02
  it("fails closed with probe_timeout when the probe takes too long, and tells the run to stop", async () => {
    const { probe, clock, calls } = setup(
      () => new Promise<string>(() => undefined),
      {
        timeoutMs: 2 * MINUTE,
      },
    );

    const pending = probe.refresh();
    await settle();
    expect(calls[0]?.aborted).toBe(false);
    await clock.advance(2 * MINUTE);
    // A run that never stops what it started is waited for during the grace time and no longer.
    await settle();
    await clock.advance(10_000);

    expect(await pending).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
      failure: "probe_timeout",
    });
    expect(calls[0]?.aborted).toBe(true);
  });

  // #331-T02
  it("names no code of its own for an error it does not know and never logs its text", async () => {
    const { probe, logger } = setup(() =>
      Promise.reject(
        new Error(
          "token ghp_" + "0123456789abcdef0123456789abcdef0123 rejected",
        ),
      ),
    );

    const outcome = await probe.refresh();

    expect(outcome).toMatchObject({ status: "failed", failure: "probe_error" });
    expect(logger.text()).not.toContain("ghp_");
    expect(JSON.stringify(outcome)).not.toContain("ghp_");
  });

  // #331-T06
  it("runs one probe for any number of concurrent callers", async () => {
    let finish: (stdout: string) => void = () => undefined;
    const { probe, calls } = setup(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const all = [
      probe.refresh(),
      probe.refresh(),
      probe.force(),
      probe.refresh(),
      probe.force(),
    ];
    await settle();
    finish(PASSING);
    const outcomes = await Promise.all(all);

    expect(calls).toHaveLength(1);
    for (const outcome of outcomes) expect(outcome.status).toBe("passed");
  });

  // #331-T06
  it("starts a new probe after the running one has ended", async () => {
    const { probe, calls } = setup(() => Promise.resolve(PASSING));

    await probe.refresh();
    await probe.refresh();

    expect(calls).toHaveLength(2);
  });

  // #331-T08
  it("keeps stable reasons only in the outcome and in the log", async () => {
    const secret = "sk-or-v1-" + "0123456789abcdef0123456789abcdef";
    const { probe, logger } = setup(() =>
      Promise.resolve(
        `${JSON.stringify({ version: 1, engines: ["pr-agent"], reasons: ["pin_untrusted", secret] })}\n`,
      ),
    );

    const outcome = await probe.refresh();

    expect(outcome.reasons).toStrictEqual(["pin_untrusted"]);
    expect(JSON.stringify(outcome)).not.toContain("sk-or");
    expect(logger.text()).not.toContain("sk-or");
  });

  // #331-T02
  it("reports the time of the check", async () => {
    const { probe, clock } = setup(() => Promise.resolve(PASSING));
    await clock.advance(5000);

    const outcome = await probe.refresh();

    expect(outcome.checkedAt).toBe(5000);
  });

  // #331-R04
  it("names an error it does not know with probe_error, and a code that is not on the closed list too", async () => {
    const { probe } = setup(() =>
      Promise.reject(new ProbeRunError("a1b2c3d4e5f6a1b2c3d4")),
    );

    expect(await probe.refresh()).toMatchObject({
      status: "failed",
      failure: "probe_error",
    });
  });

  // #331-R03
  it("serves a forced probe from an answer younger than the reuse time, and runs a new one after it", async () => {
    const { probe, clock, calls } = setup(() => Promise.resolve(PASSING), {
      forceReuseMs: 60_000,
    });
    const first = await probe.force();

    await clock.advance(59_000);
    const again = await probe.force();
    expect(again).toStrictEqual(first);
    expect(calls).toHaveLength(1);

    await clock.advance(2_000);
    await probe.force();
    expect(calls).toHaveLength(2);
  });

  // #331-R03
  it("runs every forced probe when the reuse time is zero", async () => {
    const { probe, calls } = setup(() => Promise.resolve(PASSING), {
      forceReuseMs: 0,
    });

    await probe.force();
    await probe.force();

    expect(calls).toHaveLength(2);
  });

  // #331-R03
  it("reuses a young failure too: the reuse time protects the platform, not only a pass", async () => {
    const { probe, calls } = setup(() =>
      Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );

    const first = await probe.force();
    const again = await probe.force();

    expect(first.status).toBe("failed");
    expect(again).toStrictEqual(first);
    expect(calls).toHaveLength(1);
  });

  // #331-R03
  it("reports a forced probe that failed after a pass, and serves that failure while it is young", async () => {
    const { probe, clock, calls } = setup(
      (call) =>
        call === 1
          ? Promise.resolve(PASSING)
          : Promise.reject(new ProbeRunError("probe_exec_failed")),
      { forceReuseMs: 1000 },
    );
    await probe.force();
    await clock.advance(5_000);

    const forced = await probe.force();
    const again = await probe.force();

    expect(forced).toMatchObject({
      status: "failed",
      failure: "probe_exec_failed",
    });
    expect(again).toStrictEqual(forced);
    expect(calls).toHaveLength(2);
  });

  // #331-R03
  it("reports a forced probe that timed out as probe_timeout", async () => {
    const { probe, clock } = setup(
      (call) =>
        call === 1
          ? Promise.resolve(PASSING)
          : new Promise<string>(() => undefined),
      { forceReuseMs: 1000, timeoutMs: 30_000 },
    );
    await probe.force();
    await clock.advance(5_000);

    const pending = probe.force();
    await settle();
    await clock.advance(30_000);
    await clock.advance(10_000);

    expect(await pending).toMatchObject({
      status: "failed",
      failure: "probe_timeout",
    });
  });

  // #331-R03
  it("reports a forced probe that got a real denial after a pass", async () => {
    const { probe, clock } = setup(
      (call) => Promise.resolve(call === 1 ? PASSING : DENYING),
      { forceReuseMs: 1000 },
    );
    await probe.force();
    await clock.advance(5_000);

    const forced = await probe.force();

    expect(forced.status).toBe("denied");
  });

  // #331-R05
  it("does not return after a timeout before the run has stopped what it started, within the grace time", async () => {
    let stopped = false;
    const { probe, clock } = setup(
      (_call, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            // The canary's stop call takes a while.
            setTimeout(() => {
              stopped = true;
              reject(new ProbeRunError("probe_aborted"));
            }, 30);
          });
        }),
      { timeoutMs: 20_000, abortGraceMs: 10_000 },
    );

    const pending = probe.refresh();
    await settle();
    await clock.advance(20_000);
    const outcome = await pending;

    expect(stopped).toBe(true);
    expect(outcome).toMatchObject({
      status: "failed",
      failure: "probe_timeout",
    });
  });

  // #331-R05
  it("gives up waiting for a run that never stops after the grace time", async () => {
    const { probe, clock } = setup(() => new Promise<string>(() => undefined), {
      timeoutMs: 20_000,
      abortGraceMs: 10_000,
    });

    const pending = probe.refresh();
    await settle();
    await clock.advance(20_000);
    await settle();
    await clock.advance(10_000);

    expect(await pending).toMatchObject({ failure: "probe_timeout" });
  });
});
