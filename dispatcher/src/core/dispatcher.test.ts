// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  readContract,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
} from "../test-support/harness.ts";
import { createDispatcherCore } from "./dispatcher.ts";
import { LaunchError, type HandleResult } from "./types.ts";

let app: DispatcherAppFake;
let clock: ManualClock;

beforeEach(async () => {
  app = await startApp();
  clock = new ManualClock();
});
afterEach(async () => {
  await app.close();
});

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** The real fetch, with a record of what the core sent (the fake App's log has no bodies). */
function recordingFetch() {
  const calls: Call[] = [];
  const fetchRecorded: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: text === "" ? null : (JSON.parse(text) as unknown),
    });
    return fetch(request);
  };
  return { calls, fetch: fetchRecorded };
}

function build(
  overrides: Parameters<typeof settingsFor>[1] = {},
  launcherOptions: Parameters<typeof createFakeLauncher>[0] = {},
) {
  const logger = recordingLogger();
  const launcher = createFakeLauncher(launcherOptions);
  const recorded = recordingFetch();
  const core = createDispatcherCore({
    settings: settingsFor(app.url, overrides),
    launcher,
    clock,
    logger,
    fetch: recorded.fetch,
  });
  return { core, launcher, logger, recorded };
}

async function handled(result: Promise<HandleResult>): Promise<HandleResult> {
  const outcome = await result;
  if (outcome.outcome === "started") await outcome.background;
  return outcome;
}

const heartbeats = () =>
  app.requests().filter((request) => request.route === "heartbeat").length;
const releases = () =>
  app.requests().filter((request) => request.route === "release");

/** Moves the clock one heartbeat interval at a time, waiting for each heartbeat to reach the app. */
async function beat(times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    const before = heartbeats();
    await clock.advance(30_000);
    await waitFor(() => heartbeats() > before, "a heartbeat");
    await settle();
  }
}

/** Lets the clock run until the background work of a launch is done (its releases sleep between tries). */
async function drive(background: Promise<void>): Promise<void> {
  let done = false;
  void background.then(() => {
    done = true;
  });
  for (let step = 0; step < 100 && !done; step += 1) {
    await clock.advance(10_000);
    await settle();
  }
  await background;
}

describe("the Dispatcher core", () => {
  // #327-T01
  it("claims exactly the named job with the per-job credential feature and launches it once", async () => {
    const jobId = app.enqueue();
    const { core, launcher, recorded } = build();

    const result = await handled(core.handle({ jobId, reviewKind: "diff" }));

    expect(result.outcome).toBe("started");
    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect(claim?.body).toStrictEqual({
      engines: ["pr-agent", "opencode"],
      features: ["worker_credential"],
      jobId,
      maxRunning: 4,
    });
    expect(claim?.headers.get("x-runner-id")).toBe("test-pool");
    expect(claim?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]).toMatchObject({
      appUrl: app.url,
      jobId,
      kind: "diff",
      timeoutSeconds: 1200,
      config: {},
    });
    expect(launcher.launches[0]?.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
  });

  // #327-T03
  it("ignores a job the claim does not hand out (a replay, a running or a finished job) and launches nothing", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build();
    await handled(core.handle({ jobId, reviewKind: "diff" }));

    const replay = await handled(core.handle({ jobId, reviewKind: "diff" }));

    expect(replay).toStrictEqual({ outcome: "ignored" });
    expect(launcher.launches).toHaveLength(1);
  });

  // #327-T04
  it("gives the job back with launch_failed when the launch fails, and the app counts the attempt", async () => {
    const jobId = app.enqueue();
    const { core, launcher, recorded } = build(
      {},
      {
        onLaunch: () =>
          Promise.reject(new LaunchError("sandbox_create_failed")),
      },
    );

    const result = await handled(core.handle({ jobId, reviewKind: "diff" }));

    expect(result.outcome).toBe("started");
    const release = recorded.calls.find((call) =>
      call.url.endsWith("/release"),
    );
    expect(release?.url).toBe(
      `${app.url}/api/runners/v1/jobs/${jobId}/release`,
    );
    expect(release?.body).toMatchObject({
      credential: launcher.launches[0]?.credential,
      reason: "launch_failed",
    });
    // The fake App accepts a release only with the claim's own credential; the job is queued again.
    expect(
      app.requests().filter((request) => request.route === "release"),
    ).toStrictEqual([{ method: "POST", route: "release", jobId, status: 200 }]);
    const again = await handled(core.handle({ jobId, reviewKind: "diff" }));
    expect(again.outcome).toBe("started");
  });

  // #327-T05
  it("answers not_capable without a claim when no engine can run the job's kind", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher, recorded } = build({ engines: ["pr-agent"] });

    const result = await core.handle({ jobId, reviewKind: "dynamic" });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(recorded.calls).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #327-T05
  it("claims with the engines both configured and advertised by the launcher", async () => {
    const jobId = app.enqueue();
    const { core, recorded } = build({}, { engines: ["pr-agent"] });

    await handled(core.handle({ jobId, reviewKind: "diff" }));

    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect((claim?.body as { engines: string[] }).engines).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #327-T05
  it("fails closed when the launcher cannot tell what it can run", async () => {
    const jobId = app.enqueue();
    const { core, recorded } = build({}, { capabilitiesFail: true });

    const result = await core.handle({ jobId, reviewKind: "diff" });

    expect(result.outcome).toBe("unavailable");
    expect(recorded.calls).toStrictEqual([]);
  });

  // #331-T01
  it("asks the launcher for the engine of the job's kind, and for nothing in particular when the job is not known", async () => {
    const diff = app.enqueue();
    const dynamic = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher } = build();

    await handled(core.handle({ jobId: diff, reviewKind: "diff" }));
    await handled(core.handle({ jobId: dynamic, reviewKind: "dynamic" }));
    await handled(core.handle({}));

    expect(launcher.wanted).toStrictEqual(["pr-agent", "opencode", undefined]);
  });

  // #331-T02
  it("answers unavailable with the launcher's own retry time while a probe is on its way, and claims nothing", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, recorded, logger } = build(
      {},
      { capabilitiesPendingSeconds: 25 },
    );

    const result = await core.handle({ jobId, reviewKind: "dynamic" });

    expect(result).toStrictEqual({
      outcome: "unavailable",
      retryAfterSeconds: 25,
    });
    expect(recorded.calls).toStrictEqual([]);
    expect(logger.text()).toContain("capabilities_pending");
    expect(logger.text()).not.toContain("capabilities_failed");
  });

  // #327-T06
  it("sends the pool cap with the claim and treats 204 at the cap as ignored", async () => {
    const { core, launcher, recorded } = build({ maxRunning: 2 });
    const ids = [app.enqueue(), app.enqueue(), app.enqueue()];
    for (const id of ids.slice(0, 2)) {
      await handled(core.handle({ jobId: id, reviewKind: "diff" }));
      await settle();
    }

    const third = await handled(
      core.handle({ jobId: ids[2], reviewKind: "diff" }),
    );

    expect(third).toStrictEqual({ outcome: "ignored" });
    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(
      claims.map((claim) => (claim.body as { maxRunning: number }).maxRunning),
    ).toStrictEqual([2, 2, 2]);
    expect(launcher.launches).toHaveLength(2);
  });

  // #327-T06
  it("does not claim more jobs at once than the cap while launches are in progress", async () => {
    const jobs = [app.enqueue(), app.enqueue()];
    const { core } = build(
      { maxRunning: 1 },
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );

    const first = await core.handle({ jobId: jobs[0], reviewKind: "diff" });
    const second = await core.handle({ jobId: jobs[1], reviewKind: "diff" });

    expect(first.outcome).toBe("started");
    expect(second).toMatchObject({ outcome: "busy" });
    expect(app.requests().filter((r) => r.route === "claim")).toHaveLength(1);
    core.abort();
    if (first.outcome === "started") await first.background;
  });

  // #327-T07
  it("never writes the credential or the dispatcher token into logs, results or errors", async () => {
    const jobId = app.enqueue();
    const failing = build(
      {},
      {
        // The worst case: a launcher whose error text carries the credential and the token.
        onLaunch: (spec) =>
          Promise.reject(
            new Error(
              `docker run failed for ${spec.credential} with Bearer ${DISPATCHER_TOKEN} and ${DISPATCHER_TOKEN}`,
            ),
          ),
      },
    );

    const result = await handled(
      failing.core.handle({ jobId, reviewKind: "diff" }),
    );

    const credential = failing.launcher.launches[0]?.credential ?? "";
    expect(credential).not.toBe("");
    const everything = `${failing.logger.text()}\n${JSON.stringify(result)}`;
    expect(everything).not.toContain(credential);
    expect(everything).not.toContain(DISPATCHER_TOKEN);
    expect(everything).not.toMatch(/crj_[A-Za-z0-9_-]{10,}/);
    expect(failing.logger.text()).toContain("launch_failed");
  });

  // #327-T07
  it("never logs the credential when the app misbehaves or the lease is lost", async () => {
    const jobId = app.enqueue();
    app.script("release", [{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { core, launcher, logger } = build(
      {},
      { onLaunch: () => Promise.reject(new LaunchError("boom")) },
    );

    const result = await core.handle({ jobId, reviewKind: "diff" });
    if (result.outcome === "started") await drive(result.background);

    const credential = launcher.launches[0]?.credential ?? "";
    expect(logger.text()).not.toContain(credential);
    expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
  });

  // #327-T08
  it("heartbeats with the job credential while the launch takes longer than the lease", async () => {
    const jobId = app.enqueue();
    let finishLaunch: () => void = () => undefined;
    const { core, launcher } = build(
      {},
      {
        onLaunch: () =>
          new Promise<void>((resolve) => {
            finishLaunch = resolve;
          }),
      },
    );

    const result = await core.handle({ jobId, reviewKind: "diff" });
    await settle();
    await beat(5);
    finishLaunch();
    if (result.outcome === "started") await result.background;

    const requests = app.requests();
    expect(
      requests
        .filter((r) => r.route === "heartbeat")
        .every((r) => r.status === 200 && r.jobId === jobId),
    ).toBe(true);
    expect(requests.filter((r) => r.route === "heartbeat")).toHaveLength(5);
    expect(requests.filter((r) => r.route === "release")).toStrictEqual([]);
    expect(launcher.signals[0]?.aborted).toBe(false);
  });

  // #327-T08
  it("stops heartbeating once the Worker has taken over", async () => {
    const jobId = app.enqueue();
    const { core } = build();

    await handled(core.handle({ jobId, reviewKind: "diff" }));
    const before = heartbeats();
    await clock.advance(120_000);
    await settle();

    expect(heartbeats()).toBe(before);
  });

  // #327-T08
  it("gives up at the five minute deadline: the launch is aborted and the job released", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () =>
              reject(new LaunchError("aborted")),
            ),
          ),
      },
    );

    const result = await core.handle({ jobId, reviewKind: "diff" });
    await settle();
    await beat(9);
    await clock.advance(29_000);
    expect(launcher.signals[0]?.aborted).toBe(false);
    expect(releases()).toStrictEqual([]);
    await clock.advance(1_000);
    if (result.outcome === "started") await drive(result.background);

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(app.requests().filter((r) => r.route === "release")).toStrictEqual([
      { method: "POST", route: "release", jobId, status: 200 },
    ]);
  });

  // #327-T08
  it("gives up at the deadline even when the launcher ignores the abort signal", async () => {
    const jobId = app.enqueue();
    const { core } = build(
      {},
      { onLaunch: () => new Promise<void>(() => undefined) },
    );

    const result = await core.handle({ jobId, reviewKind: "diff" });
    await settle();
    await beat(9);
    await clock.advance(30_000);
    if (result.outcome === "started") await drive(result.background);

    expect(releases()).toHaveLength(1);
  });

  // #327-T08
  it("stops the launch and releases nothing when the lease is lost (the app no longer knows the credential)", async () => {
    const jobId = app.enqueue();
    const { core, launcher, logger } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );

    const result = await core.handle({ jobId, reviewKind: "diff" });
    await settle();
    app.loseLease(jobId);
    await clock.advance(30_000);
    if (result.outcome === "started") await drive(result.background);

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(releases()).toStrictEqual([]);
    expect(logger.text()).toContain("lease_lost");
  });

  // #327 (additional): mixed versions
  it("refuses to claim against an app that lacks a feature the split needs", async () => {
    const jobId = app.enqueue();
    app.script("version", [
      {
        status: 200,
        body: { version: 1, appVersion: "0.0.1", features: ["worker_api"] },
      },
    ]);
    const { core, launcher } = build();

    const result = await core.handle({ jobId, reviewKind: "diff" });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(app.requests().filter((r) => r.route === "claim")).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #327 (additional): mixed versions
  it("refuses an app that has no version route at all (a previous release)", async () => {
    const jobId = app.enqueue();
    app.script("version", [{ status: 404 }]);
    const { core } = build();

    const result = await core.handle({ jobId, reviewKind: "diff" });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(app.requests().filter((r) => r.route === "claim")).toStrictEqual([]);
  });

  // #327 (additional): mixed versions
  it("never keeps or logs a legacy claim answer (job input, git token) a previous release sends", async () => {
    const jobId = app.enqueue();
    const legacy = readContract<{ job: { leaseToken: string } }>(
      "examples/ClaimResponse.json",
    );
    app.script("claim", [{ status: 200, body: legacy }]);
    const { core, launcher, logger } = build();

    const result = await core.handle({ jobId, reviewKind: "diff" });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(launcher.launches).toStrictEqual([]);
    expect(logger.text()).not.toContain(legacy.job.leaseToken);
  });

  // #327 (additional): the version is read once and remembered
  it("asks the app for its version once, not for every wake-up call", async () => {
    const first = app.enqueue();
    const second = app.enqueue();
    const { core } = build();

    await handled(core.handle({ jobId: first, reviewKind: "diff" }));
    await handled(core.handle({ jobId: second, reviewKind: "diff" }));

    expect(app.requests().filter((r) => r.route === "version")).toHaveLength(1);
  });

  // #327 (additional): the app is down or busy
  it.each([
    [503, 17, "unavailable", 17],
    [429, 9, "busy", 9],
    [500, undefined, "unavailable", 60],
    [401, undefined, "unavailable", 300],
  ] as const)(
    "maps a %i from the claim to %s with a retry hint",
    async (status, retryAfterSeconds, outcome, expected) => {
      const jobId = app.enqueue();
      app.script("claim", [{ status, retryAfterSeconds }]);
      const { core, launcher } = build();

      const result = await core.handle({ jobId, reviewKind: "diff" });

      expect(result).toStrictEqual({ outcome, retryAfterSeconds: expected });
      expect(launcher.launches).toStrictEqual([]);
    },
  );

  // #327 (additional): the app does not answer
  it("answers unavailable when the app cannot be reached", async () => {
    const jobId = app.enqueue();
    const { core } = build({ appUrl: "http://127.0.0.1:1" });

    const result = await core.handle({ jobId, reviewKind: "diff" });

    expect(result).toMatchObject({ outcome: "unavailable" });
  });

  // #327 (additional): the job kind decides the Worker's configuration
  it("passes the configuration of the job's kind to the launcher", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher } = build({
      workerConfig: {
        diff: {},
        dynamic: { container: { memory: { limit: "1500m" } } },
      },
    });

    await handled(core.handle({ jobId, reviewKind: "dynamic" }));

    expect(launcher.launches[0]).toMatchObject({
      kind: "dynamic",
      config: { container: { memory: { limit: "1500m" } } },
    });
  });

  // #327 (additional): graceful shutdown
  it("aborts the launches in progress and releases their jobs on shutdown", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );
    const result = await core.handle({ jobId, reviewKind: "diff" });
    await settle();

    core.abort();
    if (result.outcome === "started") await result.background;

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(app.requests().filter((r) => r.route === "release")).toHaveLength(1);
  });
});
