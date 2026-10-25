// SPDX-License-Identifier: LicenseRef-Proprietary

// The jobs of every workspace for the instance admin (#541), against a real Postgres database: two workspaces,
// a list across both with the names of the workspace and the repository, one job by its id, and nothing
// for an id nobody has.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createRunsFixture } from "../../test-support/runs.ts";
import {
  addWorkspace,
  linkTestInstallation,
} from "../../test-support/workspaces.ts";
import { createJobDirectoryRepository } from "./job-directory-repository.ts";

async function jobInAnotherWorkspace(
  f: Awaited<ReturnType<typeof createRunsFixture>>,
  copyOf: string,
) {
  const workspaceId = await addWorkspace(f.db, "bravo");
  const integration = await linkTestInstallation(f.db, workspaceId, {
    id: "9001",
    accountLogin: "bravo-org",
    accountId: 9001,
  });
  const repositoryId = "repo-bravo";
  await f.db
    .insertInto("repositories")
    .values({
      id: repositoryId,
      workspace_id: workspaceId,
      integration_id: integration.id,
      external_id: "5001",
      full_name: "bravo-org/tools",
      url: "https://github.com/bravo-org/tools",
      active: 1,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
    })
    .execute();
  const original = await f.db
    .selectFrom("jobs")
    .selectAll()
    .where("id", "=", copyOf)
    .executeTakeFirstOrThrow();
  const id = "11111111-2222-4333-8444-555555555555";
  await f.db
    .insertInto("jobs")
    .values({
      ...original,
      id,
      workspace_id: workspaceId,
      repository_id: repositoryId,
      delivery_id: null,
      pr_number: 4242,
      created_at: "2099-01-01T00:00:00.000Z",
    })
    .execute();
  return id;
}

describe("the job directory of the instance admin", () => {
  // #541-T09
  it("lists the jobs of every workspace, the newest first, with the workspace and the repository", async () => {
    const f = await createRunsFixture();
    const own = await f.finished({
      ok: true,
      result: { ok: true, commentUrl: null, logTail: "" },
    });
    const other = await jobInAnotherWorkspace(f, own.id);

    const { runs, hasMore } = await createJobDirectoryRepository(f.db).list(10);

    expect(hasMore).toBe(false);
    expect(runs.map((run) => run.id)).toEqual([other, own.id]);
    expect(runs.map((run) => [run.workspaceSlug, run.project])).toEqual([
      ["bravo", "bravo-org/tools"],
      ["default", "acme/gadgets"],
    ]);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      prNumber: 4242,
      reviewKind: "diff",
    });
    // The list never carries the result, the arguments or the lease.
    expect(JSON.stringify(runs)).not.toMatch(/logTail|leaseToken|result|args/);
  });

  // #541-T09
  it("says that the list is cut at its limit", async () => {
    const f = await createRunsFixture();
    await f.waiting();
    await f.waiting();

    const { runs, hasMore } = await createJobDirectoryRepository(f.db).list(1);

    expect(runs).toHaveLength(1);
    expect(hasMore).toBe(true);
  });

  // #541-T09: the list orders every job of the instance by creation time; without an index on it every
  // call of the page would sort them all.
  it("reads the newest jobs of the instance from an index, without sorting them all", async () => {
    const f = await createRunsFixture();
    await f.waiting();

    // With the sequential and bitmap scans out of the way the planner reads the index in order wherever there is one. (The joins of the page
    // add nothing to the order: the page is read in the order of this index.)
    const plan = await f.db.transaction().execute(async (trx) => {
      await sql`set local enable_seqscan = off`.execute(trx);
      await sql`set local enable_bitmapscan = off`.execute(trx);
      return sql<{ detail: string }>`
        explain
        select jobs.id from jobs
        order by jobs.created_at desc, jobs.id desc limit 101`.execute(trx);
    });

    const detail = plan.rows
      .map((row) => (row as Record<string, string>)["QUERY PLAN"])
      .join("\n");
    expect(detail).toContain("jobs_created_at_id");
    expect(detail).not.toMatch(/\bSort\b/);
  });

  // #541-T09
  it("reads one job by its id from any workspace, with the stored result, and nothing for an unknown id", async () => {
    const f = await createRunsFixture();
    const own = await f.finished({
      ok: true,
      result: { ok: true, commentUrl: null, logTail: "done" },
    });
    const other = await jobInAnotherWorkspace(f, own.id);
    const directory = createJobDirectoryRepository(f.db);

    const found = await directory.get(other);

    expect(found).toMatchObject({
      project: "bravo-org/tools",
      workspaceSlug: "bravo",
      job: { id: other, status: "succeeded" },
    });
    expect(found?.job.result).toMatchObject({ logTail: "done" });
    expect(
      await directory.get("00000000-0000-4000-8000-000000000000"),
    ).toBeUndefined();
  });
});
