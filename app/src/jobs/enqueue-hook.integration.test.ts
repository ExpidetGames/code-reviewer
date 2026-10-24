// SPDX-License-Identifier: LicenseRef-Proprietary

// The `onEnqueued` hook of the job queue (#326): called with the result once the enqueue committed, whatever
// it returned (a new job or an existing one), never for a refused enqueue, and never able to fail or undo one.
import { describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./job-queue.ts";
import { JobQueueError } from "./errors.ts";
import type { EnqueueResult } from "./job-types.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";

async function hooked(onEnqueued: (result: EnqueueResult) => void) {
  const fixture = await createJobQueueFixture();
  const queue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    onEnqueued,
  });
  const input = {
    repositoryId: fixture.repositoryId,
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: sha("a"),
    command: "review" as const,
    triggerKind: "webhook" as const,
    actorLogin: "octocat",
  };
  return { fixture, queue, input };
}

describe("the enqueue hook", () => {
  // #326-T09
  it("is called once per enqueue that returned, after the job is stored, with what the enqueue returned", async () => {
    const seen: { result: EnqueueResult; storedStatus: string | undefined }[] =
      [];
    const ref: { queue?: Awaited<ReturnType<typeof hooked>>["queue"] } = {};
    const { queue, input } = await hooked((result) => {
      // The hook runs after the transaction committed: the job can be read by anyone already.
      void ref.queue?.get(result.job.id).then((job) => {
        seen.push({ result, storedStatus: job?.status });
      });
    });
    ref.queue = queue;

    const created = await queue.enqueue({ ...input, deliveryId: "d-1" });
    const again = await queue.enqueue({ ...input, deliveryId: "d-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(created.status).toBe("created");
    expect(again).toMatchObject({
      status: "existing",
      reason: "same_delivery",
    });
    expect(seen.map((entry) => entry.result)).toEqual([created, again]);
    expect(seen.map((entry) => entry.storedStatus)).toEqual([
      "queued",
      "queued",
    ]);
  });

  // #326-T06
  it("cannot fail or undo an enqueue, however it fails", async () => {
    const onEnqueued = vi.fn(() => {
      throw new Error("the hook broke");
    });
    const { queue, input, fixture } = await hooked(onEnqueued);

    const result = await queue.enqueue(input);

    expect(result.status).toBe("created");
    expect(onEnqueued).toHaveBeenCalledOnce();
    expect((await fixture.queue.get(result.job.id))?.status).toBe("queued");
  });

  // #326-T06
  it("is not called when the enqueue is refused", async () => {
    const onEnqueued = vi.fn();
    const { queue, input } = await hooked(onEnqueued);

    await expect(
      queue.enqueue({ ...input, repositoryId: "no-such-repository" }),
    ).rejects.toBeInstanceOf(JobQueueError);
    await expect(
      queue.enqueue({ ...input, prNumber: -1 }),
    ).rejects.toBeInstanceOf(JobQueueError);

    expect(onEnqueued).not.toHaveBeenCalled();
  });
});
