// SPDX-License-Identifier: LicenseRef-Proprietary

// Deleting a workspace holds the Dynamic gate (shared) for the whole transaction, and a claim waits for it (#658). The deletion of the
// jobs was quadratic while `jobs.superseded_by` had no index (the foreign key's check scanned the table once per deleted job: 13.6 s
// for 20 000 jobs, a claim waited 12.8 s). With the index (20261023160000) it is linear. This pins the shape of it on Postgres:
// 8 000 jobs of the workspace next to 8 000 of another one, a third of them pointing at the job that superseded them, and a
// generous bound that the quadratic version exceeds several times over on any machine this runs on.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { seedWorkspaceForDeletion } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { createWorkspaceDeletion } from "./delete-workspace.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const JOBS_PER_WORKSPACE = 8000;
// Linear: well under a second here. Without the index about 12 s, and growing with the square.
const BOUND_MS = 4000;

async function bulkJobs(
  db: Awaited<ReturnType<typeof createPostgresTestDatabase>>["db"],
  workspaceId: string,
  repositoryId: string,
  tag: string,
) {
  // Job k points at job k + 1 (its replacement) for two of three jobs; the last of every chain stands alone.
  await sql`
    insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind,
                      actor_login, status, run_after, attempts, superseded_by, created_at, updated_at)
    select ${tag} || '-' || n, ${workspaceId}, ${repositoryId}, 1000 + n, 'https://github.test/pull/' || n,
           repeat('c', 40), 'review', '', 'webhook', 'octocat', 'succeeded', '2026-10-01T00:00:00.000Z', 0,
           case when n % 3 <> 0 and n < ${JOBS_PER_WORKSPACE} then ${tag} || '-' || (n + 1) end,
           '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
    from generate_series(1, ${JOBS_PER_WORKSPACE}) as n`.execute(db);
}

describePostgres("deleting a workspace with many jobs", () => {
  // #658-T04
  it("deletes 8 000 jobs next to 8 000 jobs of another workspace within the bound, and leaves the other ones", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 4 });
    const workspaceId = await defaultWorkspaceId(postgres.db);
    const seeded = await seedWorkspaceForDeletion(
      postgres.db,
      workspaceId,
      "a",
      { balanceMicroUsd: 0 },
    );
    const otherId = await addWorkspace(postgres.db, "other");
    const other = await seedWorkspaceForDeletion(postgres.db, otherId, "b", {
      balanceMicroUsd: 0,
    });
    const own = await postgres.db
      .selectFrom("repositories")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    const theirs = await postgres.db
      .selectFrom("repositories")
      .select("id")
      .where("workspace_id", "=", otherId)
      .executeTakeFirstOrThrow();
    await bulkJobs(postgres.db, workspaceId, own.id, "own");
    await bulkJobs(postgres.db, otherId, theirs.id, "other");
    await sql`analyze jobs`.execute(postgres.db);
    expect(seeded.queuedJobId).not.toBe(other.queuedJobId);

    const started = Date.now();
    const result = await createWorkspaceDeletion({
      db: postgres.db,
      log: () => undefined,
    }).delete({
      workspaceId,
      actorId: "owner-a",
      confirmName: "Default workspace",
    });
    const took = Date.now() - started;

    expect(result).toEqual({ ok: true });
    expect(took).toBeLessThan(BOUND_MS);
    const counts = await sql<{ workspace_id: string; count: number }>`
      select workspace_id, count(*)::int as count from jobs group by workspace_id`.execute(
      postgres.db,
    );
    expect(counts.rows).toEqual([
      { workspace_id: otherId, count: JOBS_PER_WORKSPACE + 2 },
    ]);
  });
});
