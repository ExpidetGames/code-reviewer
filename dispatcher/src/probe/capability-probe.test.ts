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
const HOUR = 60 * MINUTE;

const PASSING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;
const DENYING = `${JSON.stringify({ version: 1, engines: ["pr-agent"], reasons: ["ipv6_not_disabled"] })}\n`;

type Script = (call: number, signal: AbortSignal) => Promise<string>;

function setup(
  script: Script,
  options: { ttlMs?: number; failureTtlMs?: number; timeoutMs?: number } = {},
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
  it("proves opencode from a passing verdict and says so until the time to live is over", async () => {
    const { probe, calls } = setup(() => Promise.resolve(PASSING));

    const outcome = await probe.refresh();

    expect(outcome).toMatchObject({
      status: "passed",
      engines: ["pr-agent", "opencode"],
      reasons: [],
    });
    expect(probe.fresh()).toStrictEqual(outcome);
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

  // #331-T03
  it("runs no probe within the time to live and one after it", async () => {
    const { probe, clock, calls } = setup(() => Promise.resolve(PASSING));
    await probe.refresh();

    await clock.advance(HOUR - MINUTE);
    expect(probe.fresh()?.status).toBe("passed");
    expect(probe.ensure()).toBeUndefined();
    expect(calls).toHaveLength(1);

    await clock.advance(2 * MINUTE);
    expect(probe.fresh()).toBeUndefined();
    const started = probe.ensure();
    expect(started).toBeDefined();
    await started;
    expect(calls).toHaveLength(2);
    expect(probe.fresh()?.status).toBe("passed");
  });

  // #331-T03
  it("keeps the time to live configurable", async () => {
    const { probe, clock } = setup(() => Promise.resolve(PASSING), {
      ttlMs: 5 * MINUTE,
    });
    await probe.refresh();

    await clock.advance(5 * MINUTE + 1);

    expect(probe.fresh()).toBeUndefined();
  });

  // #331-T04
  it("tries again soon after a failure, so that a probe that recovers restores opencode", async () => {
    const { probe, clock, calls } = setup(
      (call) =>
        call === 1
          ? Promise.reject(new ProbeRunError("sandbox_network"))
          : Promise.resolve(PASSING),
      { failureTtlMs: MINUTE },
    );
    await probe.refresh();
    expect(probe.fresh()?.engines).toStrictEqual(["pr-agent"]);

    await clock.advance(MINUTE - 1000);
    expect(probe.ensure()).toBeUndefined();
    expect(calls).toHaveLength(1);

    await clock.advance(2000);
    expect(probe.fresh()).toBeUndefined();
    await probe.ensure();

    expect(probe.fresh()).toMatchObject({
      status: "passed",
      engines: ["pr-agent", "opencode"],
    });
  });

  // #331-T04
  it("takes opencode away again when a later probe fails: a pass is never carried past its time", async () => {
    const { probe, clock } = setup((call) =>
      call === 1
        ? Promise.resolve(PASSING)
        : Promise.reject(new ProbeRunError("sandbox_unavailable")),
    );
    await probe.refresh();
    await clock.advance(HOUR + 1);

    await probe.refresh();

    expect(probe.fresh()).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
    });
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
      probe.ensure(),
      probe.refresh(),
      probe.ensure(),
    ];
    await settle();
    finish(PASSING);
    const outcomes = await Promise.all(all);

    expect(calls).toHaveLength(1);
    for (const outcome of outcomes) expect(outcome?.status).toBe("passed");
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
});
