// SPDX-License-Identifier: LicenseRef-Proprietary

// #657: the review comment of a run is an empty, nullable column on the job check runs, so a row written the way the previous
// release writes it (without the column) is still valid and reads as "no comment kept yet".
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";

describe("the review comment column of the job check runs", () => {
  // #657-T04
  it("is empty for a row the previous release wrote", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();

    // The insert of the previous release: it does not name the column.
    await sql`insert into job_check_runs (job_id, workspace_id, next_attempt_at, created_at, updated_at)
      values (${job.id}, ${fixture.workspaceId}, '2026-10-23T08:00:00.000Z', '2026-10-23T08:00:00.000Z', '2026-10-23T08:00:00.000Z')`.execute(
      fixture.db,
    );

    const row = await fixture.db
      .selectFrom("job_check_runs")
      .select("review_comment")
      .where("job_id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(row.review_comment).toBeNull();
  });
});
