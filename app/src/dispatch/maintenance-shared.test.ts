// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of what happens between two sweeps on the running server (#395): nothing in poll mode (the default and
// every long-lived server), the reaction to a job that ended and the repair work of other requests in webhook mode,
// the repair work under a lock of its own. The collaborators are stand-ins; the real ones are in the integration tests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduled: [] as Array<() => Promise<void>>,
  service: undefined as unknown,
  queue: {
    countRunning: vi.fn(() => Promise.resolve(0)),
    expireStaleJobs: vi.fn(() => Promise.resolve({})),
  },
  lockKeys: [] as unknown[],
  checks: { reconcileDue: vi.fn(() => Promise.resolve({ synced: 0 })) },
}));

vi.mock("../db/startup.ts", () => ({ getDatabase: () => ({}) }));
vi.mock("../jobs/shared.ts", () => ({ getRunnerQueue: () => mocks.queue }));
vi.mock("../check-runs/shared.ts", () => ({
  getCheckRunService: () => mocks.checks,
}));
vi.mock("../db/try-lock.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/try-lock.ts")>()),
  tryWithLock: async (
    _db: unknown,
    key: unknown,
    work: () => Promise<unknown>,
  ) => {
    mocks.lockKeys.push(key);
    return { acquired: true, value: await work() };
  },
}));
vi.mock("./shared.ts", () => ({
  DispatchConfigError: class DispatchConfigError extends Error {},
  getDispatchService: () => mocks.service,
  runAfterResponse: (work: () => Promise<void>) => mocks.scheduled.push(work),
}));

import { OPPORTUNISTIC_LOCK } from "../db/try-lock.ts";

const event = {
  jobId: "job-1",
  repositoryId: "repo-1",
  prNumber: 7,
  requeued: false,
};

function webhookService() {
  return {
    sendWaiting: vi.fn(() => Promise.resolve({ sent: 0 })),
    redispatch: vi.fn(() => Promise.resolve()),
    sendDue: vi.fn(() => Promise.resolve({ sent: 0 })),
  };
}

async function load() {
  vi.resetModules();
  return import("./maintenance-shared.ts");
}

beforeEach(() => {
  mocks.scheduled.length = 0;
  mocks.lockKeys.length = 0;
  mocks.queue.countRunning.mockClear();
  mocks.queue.expireStaleJobs.mockClear();
  mocks.checks.reconcileDue.mockClear();
  mocks.service = undefined;
});

describe("what runs between two sweeps", () => {
  // #395-T11
  it("is nothing in poll mode: no work is scheduled for a job that ended or a request that touched the database", async () => {
    const { jobEnded, touched } = await load();

    jobEnded(event);
    touched();

    expect(mocks.scheduled).toHaveLength(0);
    expect(mocks.queue.expireStaleJobs).not.toHaveBeenCalled();
  });

  // #395-T09
  it("sends the jobs that waited for a slot when a job ended in webhook mode, after the response", async () => {
    const service = webhookService();
    mocks.service = service;
    const { jobEnded } = await load();

    jobEnded({ ...event, requeued: true });
    expect(service.sendWaiting).not.toHaveBeenCalled();
    for (const work of mocks.scheduled) await work();

    expect(service.sendWaiting).toHaveBeenCalledWith(
      expect.objectContaining({
        first: { repositoryId: "repo-1", prNumber: 7 },
      }),
    );
    expect(service.redispatch).toHaveBeenCalledWith("job-1", expect.anything());
  });

  // #395-T11
  it("releases expired leases and sends what is due in webhook mode, under a lock of its own, at most once per interval", async () => {
    const service = webhookService();
    mocks.service = service;
    const { touched } = await load();

    touched();
    touched();
    for (const work of mocks.scheduled) await work();

    expect(mocks.queue.expireStaleJobs).toHaveBeenCalledTimes(1);
    expect(service.sendDue).toHaveBeenCalledTimes(1);
    // #405: the check runs of the jobs that lapse released follow in the same run.
    expect(mocks.checks.reconcileDue).toHaveBeenCalledTimes(1);
    expect(mocks.lockKeys).toEqual([OPPORTUNISTIC_LOCK]);
  });

  // #395-T11
  it("never throws into the request that asked for it", async () => {
    mocks.service = webhookService();
    mocks.queue.expireStaleJobs.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { touched } = await load();

    expect(() => touched()).not.toThrow();
    await expect(mocks.scheduled[0]?.()).resolves.toBeUndefined();
  });
});
