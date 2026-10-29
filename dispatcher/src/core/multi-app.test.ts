// SPDX-License-Identifier: LicenseRef-Proprietary

// The core with several apps (#730): every call is claimed at the app it names and nowhere else, each app has its own
// credential, pool, cap and version memory, and a kind the app may not have is refused before and after the claim.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
} from "../test-support/harness.ts";
import { createDispatcherCore } from "./dispatcher.ts";
import { LaunchError, type AppSettings, type HandleResult } from "./types.ts";

const FACTORY_TOKEN = "dummy-factory-dispatcher-token-for-tests";

let reviewer: DispatcherAppFake;
let factory: DispatcherAppFake;
let clock: ManualClock;

beforeEach(async () => {
  reviewer = await startApp();
  factory = await startApp({ dispatcherToken: FACTORY_TOKEN });
  clock = new ManualClock();
});
afterEach(async () => {
  await reviewer.close();
  await factory.close();
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

function factoryApp(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "factory",
    url: factory.url,
    token: FACTORY_TOKEN,
    poolId: "factory-pool",
    maxRunning: 2,
    kinds: ["diff", "dynamic"],
    ...overrides,
  };
}

function build(
  options: {
    factory?: Partial<AppSettings>;
    reviewer?: { maxRunning?: number };
    launcher?: Parameters<typeof createFakeLauncher>[0];
  } = {},
) {
  const logger = recordingLogger();
  const launcher = createFakeLauncher(options.launcher);
  const recorded = recordingFetch();
  const core = createDispatcherCore({
    settings: settingsFor(reviewer.url, {
      ...options.reviewer,
      more: [factoryApp(options.factory)],
    }),
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const seen = (app: DispatcherAppFake, route: string) =>
  app.requests().filter((request) => request.route === route);

describe("the core with several apps", () => {
  // #730-T03
  it("claims a job of the factory at the factory's address with the factory's credential and pool, and does not call the reviewer", async () => {
    const jobId = factory.enqueue();
    const { core, launcher, recorded } = build();

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.url.startsWith(factory.url)).toBe(true);
    expect(claims[0]?.headers.get("authorization")).toBe(
      `Bearer ${FACTORY_TOKEN}`,
    );
    expect(claims[0]?.headers.get("x-runner-id")).toBe("factory-pool");
    expect(claims[0]?.body).toMatchObject({ jobId, maxRunning: 2 });
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(1);
  });

  // #730-T03
  it("claims a job of the reviewer at the reviewer's address with the reviewer's credential, and does not call the factory", async () => {
    const jobId = reviewer.enqueue();
    const { core, recorded } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect(claim?.url.startsWith(reviewer.url)).toBe(true);
    expect(claim?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(claim?.headers.get("x-runner-id")).toBe("test-pool");
    expect(factory.requests()).toHaveLength(0);
  });

  // #730-T03
  it("does not claim a job of the reviewer through the factory's key: the factory's claim sees only the factory's jobs", async () => {
    const jobId = reviewer.enqueue();
    const { core, launcher } = build();

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result).toStrictEqual({ outcome: "ignored" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(reviewer, "claim")).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T04
  it("answers `ignored` for a 204 of the factory's claim and makes no call to the other app", async () => {
    const { core, launcher } = build();
    // The factory has no such job: its claim answers 204. The reviewer has one with the same id.
    const jobId = reviewer.enqueue({
      id: "00000000-0000-4000-8000-0000000000aa",
    });

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result).toStrictEqual({ outcome: "ignored" });
    expect(seen(factory, "claim")).toHaveLength(1);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #730-T06
  it("hands the Launcher the factory's registry address and its job credential, and the app id", async () => {
    const jobId = factory.enqueue();
    const { core, launcher } = build();

    await handled(core.handle({ appId: "factory", jobId, reviewKind: "diff" }));

    expect(launcher.launches[0]).toMatchObject({
      appId: "factory",
      appUrl: factory.url,
      jobId,
      kind: "diff",
    });
    expect(launcher.launches[0]?.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
  });

  // #730-T06
  it("sends the heartbeats of a factory job, its release and its VM report to the factory only", async () => {
    const jobId = factory.enqueue();
    const hold = deferred();
    const { core } = build({
      launcher: {
        onLaunch: async (spec) => {
          spec.onVmCreated?.({
            name: "cr-diff-vm",
            startedAt: new Date("2026-10-10T12:00:00Z"),
            timeoutSeconds: 1500,
          });
          await hold.promise;
          throw new LaunchError("sandbox_create_failed");
        },
      },
    });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    expect(result.outcome).toBe("started");
    await clock.advance(30_000);
    await waitFor(() => seen(factory, "heartbeat").length > 0, "a heartbeat");
    await settle();
    hold.resolve();
    if (result.outcome === "started") {
      for (let step = 0; step < 100; step += 1) {
        await clock.advance(10_000);
        await settle();
      }
      await result.background;
    }

    expect(seen(factory, "heartbeat").length).toBeGreaterThan(0);
    expect(seen(factory, "vm")).toHaveLength(1);
    expect(factory.vms(jobId)).toHaveLength(1);
    expect(seen(factory, "release")).toHaveLength(1);
    // Not one of those reached the reviewer.
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T07
  it("gives each app its own cap: the factory at its cap answers `busy` and does not take a reviewer slot", async () => {
    const ids = [
      factory.enqueue({ id: "00000000-0000-4000-8000-0000000000b1" }),
      factory.enqueue({ id: "00000000-0000-4000-8000-0000000000b2" }),
      reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c1" }),
      reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c2" }),
    ] as const;
    const hold = deferred();
    const { core, launcher, logger } = build({
      factory: { maxRunning: 1 },
      reviewer: { maxRunning: 2 },
      launcher: { onLaunch: () => hold.promise },
    });

    const first = await core.handle({
      appId: "factory",
      jobId: ids[0],
      reviewKind: "diff",
    });
    const second = await core.handle({
      appId: "factory",
      jobId: ids[1],
      reviewKind: "diff",
    });
    // The factory is full; the reviewer still has both of its slots.
    const third = await core.handle({
      appId: "reviewer",
      jobId: ids[2],
      reviewKind: "diff",
    });
    const fourth = await core.handle({
      appId: "reviewer",
      jobId: ids[3],
      reviewKind: "diff",
    });

    expect(first.outcome).toBe("started");
    expect(second).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(third.outcome).toBe("started");
    expect(fourth.outcome).toBe("started");
    expect(launcher.launches).toHaveLength(3);
    // The ceiling is the sum of the caps: 1 + 2 launches in progress, never more.
    expect(logger.text()).toContain('busy {"app":"factory"');
    // The factory's busy claim reached nobody: its second job was not even claimed.
    expect(seen(factory, "claim")).toHaveLength(1);

    const fifth = await core.handle({
      appId: "reviewer",
      jobId: reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c3" }),
      reviewKind: "diff",
    });
    expect(fifth).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(launcher.launches).toHaveLength(3);

    hold.resolve();
    for (const result of [first, third, fourth])
      if (result.outcome === "started") await result.background;
  });

  // #730-T07
  it("sends each app's own cap with its claim", async () => {
    const { core, recorded } = build({
      factory: { maxRunning: 3 },
      reviewer: { maxRunning: 5 },
    });

    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );

    const caps = recorded.calls
      .filter((call) => call.url.endsWith("/claim"))
      .map((call) => [
        new URL(call.url).origin,
        (call.body as { maxRunning: number }).maxRunning,
      ]);
    expect(caps).toStrictEqual([
      [new URL(factory.url).origin, 3],
      [new URL(reviewer.url).origin, 5],
    ]);
  });

  // #730-T08
  it("remembers the version answer per app: a factory that is too old does not block the reviewer, and is asked again", async () => {
    factory.script("version", [{ status: 404 }]);
    const { core, logger } = build();

    const tooOld = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    const reviewerOne = await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );
    const reviewerTwo = await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );
    const factoryAgain = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(tooOld).toMatchObject({ outcome: "unavailable" });
    expect(logger.text()).toContain('app_unsupported {"app":"factory"');
    expect(reviewerOne.outcome).toBe("started");
    expect(reviewerTwo.outcome).toBe("started");
    // The reviewer's answer is remembered (one question for two jobs); the factory's failure was not.
    expect(seen(reviewer, "version")).toHaveLength(1);
    expect(factoryAgain.outcome).toBe("started");
    expect(seen(factory, "version")).toHaveLength(2);
  });

  // #730-T09
  it("answers `not_capable` for a kind outside the app's kinds and makes no claim and no call at all", async () => {
    const jobId = factory.enqueue({ reviewKind: "dynamic" });
    const { core, launcher, logger } = build({ factory: { kinds: ["diff"] } });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "dynamic",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(logger.text()).toContain("kind_not_allowed");
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #730-T09
  it("asks for the engines of the app's kinds only", async () => {
    const { core, recorded } = build({ factory: { kinds: ["diff"] } });

    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );

    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(
      claims.map((call) => (call.body as { engines: string[] }).engines),
    ).toStrictEqual([["pr-agent"], ["pr-agent", "opencode"]]);
  });

  // #730-T10
  it("releases a claimed job of a disallowed kind, logs `kind_not_allowed` as an error and creates no VM", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000d1";
    factory.enqueue({ id: jobId, reviewKind: "dynamic" });
    // An App that hands out a dynamic job although the Dispatcher asked for Diff engines only.
    factory.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"A".repeat(43)}`,
            reviewKind: "dynamic",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core, launcher, logger } = build({ factory: { kinds: ["diff"] } });

    const done = core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    const result = await (async () => {
      let value: HandleResult | undefined;
      void done.then((answer) => {
        value = answer;
      });
      for (let step = 0; step < 100 && value === undefined; step += 1) {
        await clock.advance(1000);
        await settle();
      }
      return done;
    })();

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(factory, "release").length).toBeGreaterThan(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(
      logger.lines.some((line) => line.startsWith("error kind_not_allowed")),
    ).toBe(true);
    expect(logger.text()).not.toContain("crj_");
  });

  // #730-T10
  it("gives back the slot of a job it refused", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000d2";
    factory.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"B".repeat(43)}`,
            reviewKind: "dynamic",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core } = build({ factory: { kinds: ["diff"], maxRunning: 1 } });

    const refused = core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    for (let step = 0; step < 100; step += 1) {
      await clock.advance(1000);
      await settle();
    }
    await refused;
    const next = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(next.outcome).toBe("started");
  });

  // #730-T03
  it("refuses a call that names an app it does not serve, with no call to any app", async () => {
    const { core } = build();

    const result = await core.handle({
      appId: "stranger",
      jobId: reviewer.enqueue(),
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(reviewer.requests()).toHaveLength(0);
    expect(factory.requests()).toHaveLength(0);
  });
});
