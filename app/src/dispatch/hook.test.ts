// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult, Job } from "../jobs/job-types.ts";
import { createDispatchHook } from "./hook.ts";
import type { DispatchService } from "./service.ts";

const db = {} as Kysely<Database>;
const result = {
  status: "created",
  job: { id: "job-1" } as Job,
  supersededJobIds: [],
} satisfies EnqueueResult;

const webhookEnv = {
  RUNNER_DISPATCH: "webhook",
  RUNNER_WEBHOOK_URL: "https://dispatcher.example.test/dispatch",
  RUNNER_WEBHOOK_SECRET: "dispatch-signing-secret-0123456789abcdef",
};

describe("the dispatch hook", () => {
  // #326-T07
  it("does not exist in poll mode, so nothing is scheduled, written or sent", () => {
    const schedule = vi.fn();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const env of [
      {},
      { RUNNER_DISPATCH: "poll" },
      { ...webhookEnv, RUNNER_DISPATCH: "poll" },
    ])
      expect(createDispatchHook({ env, db, schedule })).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // #326-T01
  it("hands the result of an enqueue to the scheduler, which runs it after the response", async () => {
    const onEnqueued = vi.fn(() => Promise.resolve());
    const scheduled: (() => Promise<void>)[] = [];
    const hook = createDispatchHook({
      env: webhookEnv,
      db,
      schedule: (work) => scheduled.push(work),
      service: () =>
        ({
          onEnqueued,
          sendDue: vi.fn(),
          sendJob: vi.fn(),
          sendWaiting: vi.fn(),
          redispatch: vi.fn(),
        }) as DispatchService,
    });

    hook?.(result);

    // Scheduled, not started: the service only runs when the scheduler runs the work.
    expect(scheduled).toHaveLength(1);
    expect(onEnqueued).not.toHaveBeenCalled();
    await scheduled[0]?.();
    expect(onEnqueued).toHaveBeenCalledExactlyOnceWith(result, {
      receivedAt: expect.any(Number),
    });
  });

  // #479-T09
  it("notes when the hook ran, not when the scheduler ran the work, so the budget of the retries counts the request's own time", async () => {
    const onEnqueued = vi.fn(() => Promise.resolve());
    const scheduled: (() => Promise<void>)[] = [];
    let now = 1_000;
    const hook = createDispatchHook({
      env: webhookEnv,
      db,
      schedule: (work) => scheduled.push(work),
      monotonicMs: () => now,
      service: () =>
        ({
          onEnqueued,
          sendDue: vi.fn(),
          sendJob: vi.fn(),
          sendWaiting: vi.fn(),
          redispatch: vi.fn(),
        }) as DispatchService,
    });

    hook?.(result);
    // The response is sent, and `after()` runs the work a while later.
    now = 9_000;
    await scheduled[0]?.();

    expect(onEnqueued).toHaveBeenCalledExactlyOnceWith(result, {
      receivedAt: 1_000,
    });
  });

  // #326-T08
  it("is off for a bad setting and says which variables, never their values", () => {
    const lines: string[] = [];
    const hook = createDispatchHook({
      env: {
        ...webhookEnv,
        RUNNER_WEBHOOK_SECRET: "too-short",
        RUNNER_TOKEN: "too-short",
      },
      db,
      schedule: vi.fn(),
      reportInvalid: (line) => lines.push(line),
    });

    expect(hook).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DISPATCH_CONFIG_INVALID");
    expect(lines[0]).toContain("RUNNER_WEBHOOK_SECRET");
    expect(lines[0]).not.toContain("too-short");
    expect(lines[0]).not.toContain("dispatcher.example.test");
  });
});
