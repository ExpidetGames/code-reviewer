// SPDX-License-Identifier: LicenseRef-Proprietary

// #605: the usage records say whether the money of a run is still to be settled. The column is nullable, so a record written
// the way the previous release writes it (without the column) is still valid and is never billed, the table refuses a state
// the code does not write, and the two transitions the claim and the settlement use are one-way and happen once.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createUsageRecordsRepository } from "../repositories/usage-records-repository.ts";

const stateOf = async (
  fixture: Awaited<ReturnType<typeof createJobQueueFixture>>,
  jobId: string,
) =>
  (
    await fixture.db
      .selectFrom("usage_records")
      .select("billing_state")
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow()
  ).billing_state;

describe("the billing state of a usage record", () => {
  // #605-T30
  it("is an empty column that a write of the previous release leaves empty", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();

    // The insert of the previous release: it does not name the column.
    await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
      values ('r-1', ${fixture.workspaceId}, ${job.id}, 'diff', 'own', 'reserved', '2026-10-21T12:00:00.000Z')`.execute(
      fixture.db,
    );

    expect(await stateOf(fixture, job.id)).toBeNull();
  });

  // #605-T30
  it("accepts the states the code writes and refuses any other", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();
    await createUsageRecordsRepository(fixture.db, fixture.workspaceId).reserve(
      job.id,
      "own",
    );

    await expect(
      sql`update usage_records set billing_state = 'held' where job_id = ${job.id}`.execute(
        fixture.db,
      ),
    ).rejects.toThrow();
    for (const state of ["open", "settled"]) {
      await sql`update usage_records set billing_state = ${state} where job_id = ${job.id}`.execute(
        fixture.db,
      );
      expect(await stateOf(fixture, job.id)).toBe(state);
    }
  });

  // #605-T31
  it("opens once, closes once, and never reopens or closes what was never opened", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();
    const records = createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
    );
    await records.reserve(job.id, "own");

    // A record that was never opened (billing was off at its claim) cannot be closed: it is not billed.
    expect(await records.closeBilling(job.id)).toBe(false);
    expect(await stateOf(fixture, job.id)).toBeNull();

    await records.openBilling(job.id);
    expect(await stateOf(fixture, job.id)).toBe("open");
    const closed = await Promise.all([
      records.closeBilling(job.id),
      records.closeBilling(job.id),
      records.closeBilling(job.id),
    ]);
    expect(closed.filter(Boolean)).toHaveLength(1);
    expect(await stateOf(fixture, job.id)).toBe("settled");

    // A settled record is not opened again, and another workspace's repository does not touch it.
    await records.openBilling(job.id);
    expect(await stateOf(fixture, job.id)).toBe("settled");
    await createUsageRecordsRepository(
      fixture.db,
      "another-workspace",
    ).closeBilling(job.id);
    expect(await stateOf(fixture, job.id)).toBe("settled");
  });
});
