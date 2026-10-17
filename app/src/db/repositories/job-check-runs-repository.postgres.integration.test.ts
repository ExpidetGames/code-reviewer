// SPDX-License-Identifier: Apache-2.0

// The check run record of the jobs on Postgres behaves like the SQLite one (#405-T16, T36): one statement makes the
// row of a job and one takes it, so several app instances at once get exactly one sync, a failed sync is taken again
// only after its back-off and dropped when its attempts are used up, the reconciler's query finds the jobs whose
// check run is behind, and the checks of the table refuse the same direct writes. Runs only when TEST_DATABASE_URL
// is set.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createJobCheckRunsRepository } from "./job-check-runs-repository.ts";
import { listJobsWithCheckWork } from "./job-check-runs-sweep.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const MINUTE = 60 * 1000;
const LEASE = { leaseMs: MINUTE };

/** Direct writes that the checks of the table must refuse, whatever the engine. */
const REFUSED_UPDATES = [
  ["a state the code does not know", "state = 'lost'"],
  ["a review state the code does not know", "review_state = 'maybe'"],
  ["a negative failure count", "attempts = -1"],
  ["a negative creation count", "check_create_attempts = -1"],
  ["a negative submission count", "review_submit_attempts = -1"],
] as const;

async function setup() {
  const postgres = await createPostgresTestDatabase({ poolMax: 12 });
  const fixture = await createJobQueueFixture({ database: postgres.db });
  const checks = createJobCheckRunsRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  );
  const job = await fixture.enqueueNew();
  // Not spread: the fixture's `databasePath` throws for a Postgres database.
  return {
    db: fixture.db,
    workspaceId: fixture.workspaceId,
    queue: fixture.queue,
    clock: fixture.clock,
    checks,
    job,
  };
}

describePostgres("the job check runs on Postgres", () => {
  // #405-T16
  it("hands the job to one of several concurrent callers, and only that one sees the row as new", async () => {
    const t = await setup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => t.checks.take(t.job.id, LEASE)),
    );

    const taken = results.filter((result) => result.acquired);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ created: true });
  });

  // #405-T15
  it("takes a failed sync again only after its back-off, and drops it when its attempts are used up", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.failed(t.job.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: new Date(t.clock.now().getTime() + 5 * MINUTE),
      maxAttempts: 2,
    });
    t.clock.advance(4 * MINUTE);
    expect((await t.checks.take(t.job.id, LEASE)).acquired).toBe(false);
    t.clock.advance(2 * MINUTE);
    expect(await t.checks.take(t.job.id, LEASE)).toMatchObject({
      acquired: true,
      created: false,
      check: { attempts: 1 },
    });
    await t.checks.failed(t.job.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: t.clock.now(),
      maxAttempts: 2,
    });

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "dropped",
      attempts: 2,
    });
    t.clock.advance(60 * MINUTE);
    expect((await t.checks.take(t.job.id, LEASE)).acquired).toBe(false);
  });

  // #405-T06
  it("lists a job whose check run shows another status than the job has, and not one that is in step", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "queued",
    });
    await t.checks.finish(t.job.id, { settled: false });
    expect(
      await listJobsWithCheckWork(t.db, t.clock.now(), { limit: 10 }),
    ).toEqual([]);

    await t.queue.claimNext("runner-1");

    expect(
      await listJobsWithCheckWork(t.db, t.clock.now(), { limit: 10 }),
    ).toEqual([{ jobId: t.job.id, workspaceId: t.workspaceId }]);
  });

  // #405-T36
  it.each(REFUSED_UPDATES)(
    "refuses a direct write of %s",
    async (_name, assignment) => {
      const t = await setup();
      await t.checks.take(t.job.id, LEASE);

      await expect(
        sql`update job_check_runs set ${sql.raw(assignment)}`.execute(t.db),
      ).rejects.toThrow();
    },
  );
});
