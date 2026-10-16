// SPDX-License-Identifier: Apache-2.0

// #397-T14: the two migrations of the supersede (the flag of the claim and the wider reason of a usage record) run
// on a database made by the previous release's migrations: every job gets the flag 0, every usage record keeps its
// reason, the default of the flag stays so an older app instance still inserts jobs, and the table now accepts
// `superseded` and still refuses any other reason.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";

const FIRST = "20261016140000_add_job_accepts_supersede";

const before: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < FIRST,
      ),
    );
  },
};

const T = "2026-10-16T08:00:00.000Z";

describe("the migrations of the supersede", () => {
  // #397-T14
  it("give every job the flag 0, keep the reasons of the usage records and accept the new reason", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    try {
      await migrateToLatest(db, before);
      await db
        .insertInto("workspaces")
        .values({
          id: "w-1",
          name: "acme",
          slug: "acme",
          created_by: null,
          created_at: T,
        })
        .execute();
      await db
        .insertInto("integrations")
        .values({
          id: "i-1",
          workspace_id: "w-1",
          type: "github_app",
          display_name: "acme",
          external_id: "4242",
          config: "{}",
          credentials: null,
          webhook_secret: null,
          status: "active",
          created_at: T,
          updated_at: T,
        })
        .execute();
      await db
        .insertInto("repositories")
        .values({
          id: "r-1",
          workspace_id: "w-1",
          integration_id: "i-1",
          external_id: "7001",
          full_name: "acme/widgets",
          url: "https://github.test/acme/widgets",
          active: 1,
          created_at: T,
          updated_at: T,
        })
        .execute();
      for (const [id, pr] of [
        ["j-1", 8],
        ["j-2", 9],
      ] as const)
        await db
          .insertInto("jobs")
          .values({
            id,
            workspace_id: "w-1",
            repository_id: "r-1",
            pr_number: pr,
            pr_url: `https://github.test/acme/widgets/pull/${String(pr)}`,
            head_sha: "a".repeat(40),
            command: "review",
            args: "",
            trigger_kind: "webhook",
            actor_login: "octocat",
            delivery_id: `d-${id}`,
            status: "failed",
            run_after: T,
            attempts: 0,
            runner_id: null,
            lease_token: null,
            claimed_at: null,
            heartbeat_at: null,
            lease_expires_at: null,
            result: null,
            error_code: "lease_expired",
            superseded_by: null,
            created_at: T,
            updated_at: T,
            finished_at: T,
          })
          .execute();
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at, settled_at, settled_reason)
        values ('u-1', 'w-1', 'j-1', 'diff', 'own', 'settled', ${T}, ${T}, 'no_result')`.execute(
        db,
      );
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
        values ('u-2', 'w-1', 'j-2', 'diff', 'own', 'reserved', ${T})`.execute(
        db,
      );

      await migrateToLatest(db, migrationProvider);

      const jobs = await db
        .selectFrom("jobs")
        .select(["id", "accepts_supersede"])
        .execute();
      expect(jobs.map((job) => job.accepts_supersede)).toEqual([0, 0]);
      const records = await db
        .selectFrom("usage_records")
        .select(["id", "settled_reason", "state"])
        .orderBy("id")
        .execute();
      expect(records).toEqual([
        { id: "u-1", settled_reason: "no_result", state: "settled" },
        { id: "u-2", settled_reason: null, state: "reserved" },
      ]);
      await sql`update usage_records set settled_reason = 'superseded' where id = 'u-2'`.execute(
        db,
      );
      await expect(
        sql`update usage_records set settled_reason = 'lost' where id = 'u-2'`.execute(
          db,
        ),
      ).rejects.toThrow();
      // The previous release inserts a job without naming the column.
      await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login, delivery_id, status, run_after, attempts, created_at, updated_at)
        values ('j-3', 'w-1', 'r-1', 10, 'https://github.test/acme/widgets/pull/10', ${"b".repeat(40)}, 'review', '', 'webhook', 'octocat', 'd-3', 'queued', ${T}, 0, ${T}, ${T})`.execute(
        db,
      );
      expect(
        (
          await db
            .selectFrom("jobs")
            .select("accepts_supersede")
            .where("id", "=", "j-3")
            .executeTakeFirstOrThrow()
        ).accepts_supersede,
      ).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
