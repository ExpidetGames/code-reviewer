// SPDX-License-Identifier: LicenseRef-Proprietary

// A job of a review kind needs the capability of that kind (#731): a deployment without `dynamic-review` never queues a
// Dynamic job, and one without `review` queues none, however the kind got to the queue (named by the caller or read from
// the project's settings). Nothing is written when the enqueue is refused.
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { createJobQueue } from "./job-queue.ts";
import { JobQueueError } from "./errors.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";

async function queueWith(
  capabilities: Parameters<typeof createCapabilitySet>[0],
) {
  const fixture = await createJobQueueFixture();
  const set = createCapabilitySet(capabilities);
  const queue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    kindAllowed: (kind) => set.allowsReviewKind(kind),
    dynamicReviewEnabled: async () => true,
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
  const jobCount = async () =>
    Number(
      (
        await fixture.db
          .selectFrom("jobs")
          .select((eb) => eb.fn.countAll().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    );
  return { queue, input, jobCount };
}

describe("the job queue of a deployment with a capability set", () => {
  // #731-T05
  it("refuses a Dynamic job without dynamic-review and writes nothing", async () => {
    const { queue, input, jobCount } = await queueWith(["review"]);

    await expect(
      queue.enqueue({ ...input, reviewKind: "dynamic" }),
    ).rejects.toMatchObject({
      name: "JobQueueError",
      code: "JOB_KIND_UNAVAILABLE",
    });
    expect(await jobCount()).toBe(0);
  });

  // #731-T05
  it("still queues a Diff job without dynamic-review", async () => {
    const { queue, input } = await queueWith(["review"]);

    const result = await queue.enqueue({ ...input, reviewKind: "diff" });

    expect(result.status).toBe("created");
    expect(result.job.reviewKind).toBe("diff");
  });

  // #731-T04
  it("refuses every job without review", async () => {
    const { queue, input, jobCount } = await queueWith([]);

    for (const reviewKind of ["diff", "dynamic"] as const)
      await expect(
        queue.enqueue({ ...input, reviewKind }),
      ).rejects.toBeInstanceOf(JobQueueError);
    expect(await jobCount()).toBe(0);
  });

  // #731-T01
  it("queues both kinds with the full set, as before", async () => {
    const { queue, input } = await queueWith(["review", "dynamic-review"]);

    expect((await queue.enqueue({ ...input, reviewKind: "diff" })).status).toBe(
      "created",
    );
    expect(
      (await queue.enqueue({ ...input, prNumber: 8, reviewKind: "dynamic" }))
        .status,
    ).toBe("created");
  });
});
