// SPDX-License-Identifier: Apache-2.0

// The usage records on Postgres behave like the SQLite ones (#272-T10): the claim reserves, the completion
// settles, a job that ends without reporting is voided, the checks of the table refuse the same direct writes,
// and the page of settled records is ordered by `(settled_at, id)`. The columns and types are compared with
// SQLite by the schema parity test in ../postgres.integration.test.ts. Runs only when TEST_DATABASE_URL is set.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const MINUTE = 60 * 1000;

/** Direct writes that the checks of the table must refuse, whatever the engine. */
const REFUSED_UPDATES = [
  ["a state the code does not know", "state = 'lost'"],
  ["a settled record without its time", "state = 'settled'"],
  ["a cost on a record that is not settled", "cost_micro_usd = 5"],
  ["a key mode the code does not know", "key_mode = 'shared'"],
] as const;

describePostgres("the usage records on Postgres", () => {
  // #272-T10
  it("reserves at the claim, settles at the completion and pages the settled records", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const records = createUsageRecordsRepository(
      postgres.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    const job = await fixture.enqueueNew();

    const claimed = await fixture.queue.claimNext("runner-a");
    expect(await records.get(job.id)).toMatchObject({
      state: "reserved",
      reviewKind: "diff",
      keyMode: "own",
    });
    fixture.clock.advance(MINUTE);
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: {
          promptTokens: 12000,
          completionTokens: 900,
          costUsd: 0.0123456,
        },
      },
    });

    expect(await records.get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 12000,
      completionTokens: 900,
    });
    const page = await records.pageSettled({ limit: 10 });
    expect(page.records.map((record) => record.jobId)).toEqual([job.id]);
    expect(await records.countByKind("2000-01-01T00:00:00.000Z")).toEqual({
      diff: 1,
      dynamic: 0,
    });
    await records.setKeyMode(job.id, "managed");
    expect(
      await records.sumSettledManagedCostMicroUsd("2000-01-01T00:00:00.000Z"),
    ).toBe(0);
  });

  // #272-T10
  it("sums the settled managed cost of a record as a number", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const records = createUsageRecordsRepository(
      postgres.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    const job = await fixture.enqueueNew();
    await records.reserve(job.id, "managed");
    await records.settle(job.id, {
      state: "settled",
      costMicroUsd: 2_000_000_000,
      promptTokens: 2_000_000_000,
      completionTokens: 1,
    });

    expect(
      await records.sumSettledManagedCostMicroUsd("2000-01-01T00:00:00.000Z"),
    ).toBe(2_000_000_000);
    expect(await records.get(job.id)).toMatchObject({
      costMicroUsd: 2_000_000_000,
      promptTokens: 2_000_000_000,
    });
  });

  // #272-T10
  it("voids the record of a job that lost its last attempt", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const records = createUsageRecordsRepository(
      postgres.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    const job = await fixture.enqueueNew();
    await postgres.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(3 * MINUTE);

    await fixture.queue.expireStaleJobs();

    expect((await fixture.queue.get(job.id))?.status).toBe("failed");
    expect((await records.get(job.id))?.state).toBe("void");
  });

  // #272-T10
  it.each(REFUSED_UPDATES)(
    "refuses %s, like SQLite",
    async (_name, assignment) => {
      const postgres = await createPostgresTestDatabase();
      const fixture = await createJobQueueFixture({ database: postgres.db });
      const job = await fixture.enqueueNew();
      await createUsageRecordsRepository(
        postgres.db,
        fixture.workspaceId,
        fixture.clock.now,
      ).reserve(job.id, "own");

      await expect(
        sql`update usage_records set ${sql.raw(assignment)} where job_id = ${job.id}`.execute(
          postgres.db,
        ),
      ).rejects.toThrow();
    },
  );

  // #272-T10
  it("allows one record per job", async () => {
    const postgres = await createPostgresTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const job = await fixture.enqueueNew();
    const insert = () =>
      sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
        values (${crypto.randomUUID()}, ${fixture.workspaceId}, ${job.id}, 'diff', 'own', 'reserved', '2026-10-14T12:00:00.000Z')`.execute(
        postgres.db,
      );
    await insert();

    await expect(insert()).rejects.toThrow();
  });
});
