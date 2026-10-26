// SPDX-License-Identifier: LicenseRef-Proprietary

// #498 (the gate of the review of #524): `job_vm_runs.end_source` takes two more values, `app_stop_unreported` and
// `claim_wall_clock`. The rows of an existing database survive the change with their key, checks and index, and a source that
// is none of the five is still refused. Postgres replaces the constraint.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import {
  createEmptyTestDatabase,
  createTestDatabase,
} from "../../test-support/test-database.ts";
import { migrateToLatest } from "../migrate.ts";

const SPLIT = "20261021090100_widen_job_vm_runs_end_source";
const T = "2026-10-12T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

type Db = Kysely<Database>;

async function seedJob(db: Db) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', null, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', '1', '{}', 'active', ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', '1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login, status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', 7, 'https://github.test/acme/widgets/pull/7', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat', 'queued', ${T}, 0, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
}

async function seedRun(db: Db, name: string, source: string | null) {
  await seedJob(db);
  await sql`insert into job_vm_runs (job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, ended_at, end_source, billable, billable_minutes, created_at, updated_at)
    values ('j-1', ${name}, 'w-1', 1, ${T}, ${T}, ${T}, ${source === null ? null : T}, ${source}, 0, null, ${T}, ${T})`.execute(
    db,
  );
}

describe("the job VM end source migration", () => {
  // #498-B1
  it("keeps the rows of an existing database and accepts the two new sources", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedRun(db, "vm-1", "timeout_backstop");

    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{
      vm_name: string;
      end_source: string;
    }>`select vm_name, end_source from job_vm_runs`.execute(db);
    expect(rows).toEqual([{ vm_name: "vm-1", end_source: "timeout_backstop" }]);
    await seedRun(db, "vm-2", "app_stop_unreported");
    await seedRun(db, "vm-3", "claim_wall_clock");
    await expect(seedRun(db, "vm-4", "not_a_source")).rejects.toThrow();
    // The key survives: a second report of a VM changes nothing.
    await expect(seedRun(db, "vm-2", "app_stop_confirmed")).rejects.toThrow();
    // The pair of the end survives: a source without an end is refused.
    await expect(
      sql`insert into job_vm_runs (job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, ended_at, end_source, billable, created_at, updated_at)
        values ('j-1', 'vm-5', 'w-1', 1, ${T}, ${T}, ${T}, null, 'claim_wall_clock', 0, ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
    const indexes = await sql<{
      name: string;
    }>`select indexname as name from pg_indexes where tablename = 'job_vm_runs'`.execute(
      db,
    );
    expect(indexes.rows.map((row) => row.name)).toContain(
      "job_vm_runs_workspace_job",
    );
  });

  // #498-B1
  it("accepts the two new sources on Postgres and still refuses any other", async () => {
    const { db } = await createTestDatabase();

    await seedRun(db as unknown as Db, "vm-1", "app_stop_unreported");
    await seedRun(db as unknown as Db, "vm-2", "claim_wall_clock");
    await expect(
      seedRun(db as unknown as Db, "vm-3", "not_a_source"),
    ).rejects.toThrow();
  });
});
