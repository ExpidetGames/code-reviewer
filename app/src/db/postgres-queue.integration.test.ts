// SPDX-License-Identifier: Apache-2.0

// The job queue on Postgres: the partial unique index on running jobs per pull request exists on both
// dialects, many runners never get the same job and never start two jobs of one pull request, and a
// unique violation inside the claim (the slot was taken at the same moment) is skipped, not raised.
// The Postgres tests run only when TEST_DATABASE_URL is set.
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createRunnerQueue } from "../jobs/runner-queue.ts";
import type { Database } from "./schema.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const RUNNING_INDEX = "jobs_one_running_per_pull_request_unique";
const T = "2026-10-10T12:00:00.000Z";

/** `postgres://...?application_name=<name>`, so a backend can be found in `pg_stat_activity`. */
function withApplicationName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

/**
 * Waits until the backend of `name` is waiting on a lock, so the test can release the holder at a
 * moment it can name instead of guessing. Bounded: a bug fails the test instead of hanging.
 */
async function waitForLockWait(
  db: Kysely<Database>,
  name: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${name} and wait_event_type = 'Lock'`.execute(
      db,
    );
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Backend ${name} never waited on a lock.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the index that keeps one running job per pull request", () => {
  // #105-PG-20
  it("exists on SQLite", async () => {
    const { db } = await createTestDatabase();
    const { rows } = await sql<{ present: boolean }>`
      select exists(
        select 1 from sqlite_master
        where type = 'index' and name = ${RUNNING_INDEX}
      ) as present`.execute(db);

    expect(Boolean(rows[0]?.present)).toBe(true);
  });
});

describePostgres("the job queue on Postgres", () => {
  // #105-PG-20
  it("has the partial unique index, on a running status, like SQLite", async () => {
    const postgres = await createPostgresTestDatabase();
    const { rows } = await sql<{ definition: string }>`
      select indexdef as definition from pg_indexes
      where indexname = ${RUNNING_INDEX}`.execute(postgres.db);

    expect(rows[0]?.definition).toMatch(/UNIQUE/);
    expect(rows[0]?.definition).toMatch(/status.*running/i);
  });

  // #105-PG-07
  it("never gives one job to two runners and never runs two jobs of one pull request", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    for (let pr = 1; pr <= 4; pr += 1)
      for (const head of ["a", "b", "c"] as const)
        await fixture.enqueueNew({
          prNumber: pr,
          prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
          headSha: sha(head),
        });

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.queue.claimNext(`runner-${String(index)}`),
      ),
    );
    const claimedIds = claims.flatMap((claim) =>
      claim === null ? [] : [claim.job.id],
    );

    // No job was handed out twice, and every claim produced a running job.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    const running = await postgres.db
      .selectFrom("jobs")
      .select(["repository_id", "pr_number"])
      .where("status", "=", "running")
      .execute();
    expect(running).toHaveLength(claimedIds.length);
    // At most one running job per pull request.
    const perPullRequest = running.map(
      (row) => `${row.repository_id}:${String(row.pr_number)}`,
    );
    expect(new Set(perPullRequest).size).toBe(perPullRequest.length);
    // Nothing was lost.
    const { rows: counts } = await sql<{ count: number }>`
      select count(*)::int as count from jobs`.execute(postgres.db);
    expect(counts[0]?.count).toBe(12);
  });

  // #105-PG-20
  it("gives only one of two jobs of one pull request to two runners at the same moment", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const first = await fixture.enqueueNew({ prNumber: 7, headSha: sha("a") });
    const second = await fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    const other = await fixture.enqueueNew({ prNumber: 8, headSha: sha("c") });

    const [one, two] = await Promise.all([
      fixture.queue.claimNext("runner-1"),
      fixture.queue.claimNext("runner-2"),
    ]);
    const claimedIds = [one?.job.id, two?.job.id].filter(
      (id): id is string => id !== undefined,
    );

    // Exactly one of the two jobs of pull request 7, and the runner that lost the race took the
    // job of pull request 8.
    expect(
      claimedIds.filter((id) => id === first.id || id === second.id),
    ).toHaveLength(1);
    expect(claimedIds).toContain(other.id);
  });

  // #105-PG-21
  it("skips a job whose running slot was taken at the same moment and claims the next one", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    await fixture.enqueueNew({ prNumber: 7, headSha: sha("a") });
    await fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    const next = await fixture.enqueueNew({ prNumber: 8, headSha: sha("c") });

    // A second connection holds a running job of pull request 7 without committing. The claim's
    // snapshot does not see it, so it tries to run a job of pull request 7; the unique index does,
    // so that update raises a duplicate key error.
    const holder = connectPostgres(
      withApplicationName(postgres.url, "cr_hold"),
    );
    await sql`begin`.execute(holder.db);
    await sql`
      insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args,
                        trigger_kind, actor_login, delivery_id, status, run_after, attempts, runner_id,
                        lease_token, claimed_at, heartbeat_at, lease_expires_at, result, error_code,
                        superseded_by, created_at, updated_at, finished_at)
      values (${randomUUID()}, ${fixture.workspaceId}, ${fixture.repositoryId}, 7,
              'https://github.test/acme/widgets/pull/7', ${sha("f")}, 'review', '', 'webhook',
              'octocat', null, 'running', ${T}, 0, 'holder', 'holder-token', ${T}, ${T}, null, null,
              null, null, ${T}, ${T}, null)`.execute(holder.db);

    const waiter = connectPostgres(
      withApplicationName(postgres.url, "cr_waiter"),
    );
    const queue = createRunnerQueue(waiter.db, { now: fixture.clock.now });
    const pending = queue.claimNext("runner-1");
    await waitForLockWait(postgres.db, "cr_waiter");
    await sql`commit`.execute(holder.db);

    const claimed = await pending;
    await holder.close();
    await waiter.close();

    // The transaction survived: the claim skipped pull request 7 and took pull request 8.
    expect(claimed?.job.id).toBe(next.id);
  });
});
