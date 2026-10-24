// SPDX-License-Identifier: LicenseRef-Proprietary

// #273: the usage records get a reason for a settlement without a report of the run. The column is nullable, so a
// record written the way the previous release writes it (without the column) is still valid and has no reason, and
// the table refuses a reason the code does not write.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createUsageRecordsRepository } from "../repositories/usage-records-repository.ts";

describe("the settled reason of a usage record", () => {
  // #273 (no case of its own: the migration is not a behavior of the issue)
  it("is an empty column that a write of the previous release leaves empty", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();

    // The insert of the previous release: it does not name the column.
    await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
      values ('r-1', ${fixture.workspaceId}, ${job.id}, 'diff', 'own', 'reserved', '2026-10-15T12:00:00.000Z')`.execute(
      fixture.db,
    );

    const records = createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
    );
    expect(await records.get(job.id)).toMatchObject({
      state: "reserved",
      settledReason: null,
    });
  });

  it("accepts the reason the code writes and refuses any other", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();
    await createUsageRecordsRepository(fixture.db, fixture.workspaceId).reserve(
      job.id,
      "own",
    );

    await expect(
      sql`update usage_records set settled_reason = 'lost' where job_id = ${job.id}`.execute(
        fixture.db,
      ),
    ).rejects.toThrow();
    await sql`update usage_records set state = 'settled', settled_at = '2026-10-15T12:00:00.000Z', settled_reason = 'no_result' where job_id = ${job.id}`.execute(
      fixture.db,
    );

    const records = createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
    );
    expect(await records.get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
    });
  });
});
