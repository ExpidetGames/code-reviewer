// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createJobEndedReaction } from "./job-ended.ts";

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
  const react = createJobEndedReaction({
    dispatch,
    countRunning: () => Promise.resolve(options.running ?? 0),
    maxRunning: () => options.cap,
    log,
  });
  return { react, dispatch, log };
}

describe("what the app does when a job ends", () => {
  // #395-T09
  it("sends one waiting job, the one of the same pull request first, when it does not know the pool cap", async () => {
    const t = setup({ cap: null });

    await t.react(event);

    expect(t.dispatch.sendWaiting).toHaveBeenCalledWith({
      limit: 1,
      first: { repositoryId: "repo-1", prNumber: 7 },
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
  it("sends a job that was given back again, and still frees the slot", async () => {
    const t = setup({ cap: null });

    await t.react({ ...event, requeued: true });

    expect(t.dispatch.redispatch).toHaveBeenCalledWith("job-1");
    expect(t.dispatch.sendWaiting).toHaveBeenCalledOnce();
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
