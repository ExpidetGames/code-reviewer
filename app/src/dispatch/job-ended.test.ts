// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createJobEndedReaction, JOB_ENDED_BUDGET_MS } from "./job-ended.ts";

const event = {
  jobId: "job-1",
  repositoryId: "repo-1",
  prNumber: 7,
  requeued: false,
};

function setup(options: { cap: number | null; running?: number }) {
  const dispatch = {
    sendWaiting: vi.fn(() => Promise.resolve({ sent: 0 })),
    redispatch: vi.fn(() => Promise.resolve()),
  };
  const log = { error: vi.fn() };
  const clock = { now: 1_000 };
  const react = createJobEndedReaction({
    monotonicMs: () => clock.now,
    dispatch,
    countRunning: () => Promise.resolve(options.running ?? 0),
    maxRunning: () => options.cap,
    log,
  });
  return { react, dispatch, log, clock };
}

describe("what the app does when a job ends", () => {
  // #395-T09
  it("sends one waiting job, the one of the same pull request first, when it does not know the pool cap", async () => {
    const t = setup({ cap: null });

    await t.react(event);

    expect(t.dispatch.sendWaiting).toHaveBeenCalledWith({
      limit: 1,
      first: { repositoryId: "repo-1", prNumber: 7 },
      deadline: expect.any(Number),
    });
    expect(t.dispatch.redispatch).not.toHaveBeenCalled();
  });

  // #395-T10
  it.each([
    [10, 3, 7],
    [10, 9, 1],
    [10, 10, 0],
    [10, 14, -4],
    [100, 0, 20],
  ])(
    "sends as many as there are free slots below the pool cap %i with %i running (%i)",
    async (cap, running, limit) => {
      const t = setup({ cap, running });

      await t.react(event);

      expect(t.dispatch.sendWaiting).toHaveBeenCalledWith(
        expect.objectContaining({ limit }),
      );
    },
  );

  // #395-T09
  it("frees the slot before it waits for the retry time of a job that was given back, with one deadline for both", async () => {
    const t = setup({ cap: null });
    const calls: string[] = [];
    t.dispatch.sendWaiting.mockImplementation(() => {
      calls.push("sendWaiting");
      return Promise.resolve({ sent: 0 });
    });
    t.dispatch.redispatch.mockImplementation(() => {
      calls.push("redispatch");
      return Promise.resolve();
    });

    await t.react({ ...event, requeued: true });

    expect(calls).toEqual(["sendWaiting", "redispatch"]);
    const [options] = t.dispatch.sendWaiting.mock.calls[0] as unknown as [
      { deadline: number },
    ];
    const waiting = options;
    expect(t.dispatch.redispatch).toHaveBeenCalledWith("job-1", {
      deadline: waiting.deadline,
    });
    // 45 seconds from the start of the reaction: a send that starts before ends within the 60 of the function.
    expect(waiting.deadline - t.clock.now).toBe(JOB_ENDED_BUDGET_MS);
  });

  // #395-T09
  it("still sends a job that was given back when the pool cap is full", async () => {
    const t = setup({ cap: 5, running: 5 });

    await t.react({ ...event, requeued: true });

    expect(t.dispatch.redispatch).toHaveBeenCalledOnce();
  });

  // #395-T09
  it("never throws and logs a stable code only", async () => {
    const t = setup({ cap: 5 });
    t.dispatch.sendWaiting.mockRejectedValueOnce(
      new Error("postgres://user:secret@host/db"),
    );

    await expect(t.react(event)).resolves.toBeUndefined();

    expect(t.log.error).toHaveBeenCalledWith(
      "[dispatch] JOB_ENDED_DISPATCH_FAILED",
    );
  });
});
