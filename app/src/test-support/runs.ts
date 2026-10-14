// SPDX-License-Identifier: Apache-2.0

// Fixtures for the tests of the runs pages: runs in every state, made through the job queue the way the
// running app makes them (enqueue, claim, complete), never by writing rows. Builds on the job queue
// fixture: two repositories, a clock the test moves by hand.
import { createRunsRepository } from "../db/repositories/runs-repository.ts";
import type { EnqueueJobInput, Job, JobOutcome } from "../jobs/job-types.ts";
import { createRunsService } from "../runs/runs-service.ts";
import { createJobQueueFixture, type JobQueueFixture } from "./jobs.ts";

export type RunsFixture = JobQueueFixture & {
  runs: ReturnType<typeof createRunsService>;
  runsRepository: ReturnType<typeof createRunsRepository>;
  /**
   * Enqueues a job and leaves it waiting. Make waiting runs last: `running` and `finished` claim
   * the oldest due job until theirs is handed out, so an older waiting job would be taken first.
   */
  waiting(overrides?: Partial<EnqueueJobInput>): Promise<Job>;
  /** Enqueues a job, lets a runner claim it, and leaves it running. */
  running(overrides?: Partial<EnqueueJobInput>): Promise<Job>;
  /** Enqueues a job, lets a runner claim it, and completes it with `outcome`. */
  finished(
    outcome: JobOutcome,
    overrides?: Partial<EnqueueJobInput>,
  ): Promise<Job>;
};

let nextPr = 100;

export async function createRunsFixture(
  options: { dynamicReview?: boolean } = {},
): Promise<RunsFixture> {
  const base = await createJobQueueFixture({
    ...(options.dynamicReview === undefined
      ? {}
      : { dynamicReview: options.dynamicReview }),
  });
  const runsRepository = createRunsRepository(base.db, base.workspaceId);
  const runs = createRunsService({
    runs: runsRepository,
    now: base.clock.now,
  });

  const claimed = async (overrides: Partial<EnqueueJobInput>) => {
    // Every run gets a pull request of its own: one pull request runs one job at a time.
    nextPr += 1;
    base.clock.advance(1000);
    const job = await base.enqueueNew({
      prNumber: nextPr,
      prUrl: `https://github.com/acme/widgets/pull/${nextPr}`,
      ...overrides,
    });
    // The queue hands out the oldest due job: claim until it is this one.
    for (;;) {
      const claim = await base.queue.claimNext("runner-1", [
        "pr-agent",
        "opencode",
      ]);
      if (claim === null) throw new Error("The job was never handed out.");
      if (claim.job.id === job.id) return claim;
    }
  };

  return {
    ...base,
    runs,
    runsRepository,
    async waiting(overrides = {}) {
      nextPr += 1;
      base.clock.advance(1000);
      return base.enqueueNew({
        prNumber: nextPr,
        prUrl: `https://github.com/acme/widgets/pull/${nextPr}`,
        ...overrides,
      });
    },
    async running(overrides = {}) {
      return (await claimed(overrides)).job;
    },
    async finished(outcome, overrides = {}) {
      const claim = await claimed(overrides);
      base.clock.advance(50_000);
      const result = await base.queue.complete(
        claim.job.id,
        claim.leaseToken,
        outcome,
      );
      if (result.status !== "completed")
        throw new Error(`The job was not completed: ${result.status}`);
      return result.job;
    },
  };
}
