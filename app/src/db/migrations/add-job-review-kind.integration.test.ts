// SPDX-License-Identifier: LicenseRef-Proprietary

// #195-T03: the queue migration adds `review_kind` with a `diff` backfill and widens the automatic
// per-head uniqueness to the kind. It must run on a database made by the previous release's
// migrations, keep every job (waiting, running and finished) and its delivery id as Diff, and let the
// same head hold one Diff and one Dynamic automatic job at the same time afterwards.
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const SPLIT = "20261013090000_add_job_review_kind";

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

const T = "2026-10-12T08:00:00.000Z";

async function openPreviousReleaseDatabase() {
  const { db } = await createEmptyTestDatabase();
  await migrateToLatest(db, beforeThisMigration);
  return db;
}

async function seed(
  db: Awaited<ReturnType<typeof openPreviousReleaseDatabase>>,
) {
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
  const base = {
    workspace_id: "w-1",
    repository_id: "r-1",
    pr_number: 7,
    pr_url: "https://github.test/acme/widgets/pull/7",
    head_sha: "a".repeat(40),
    command: "review",
    args: "",
    trigger_kind: "webhook",
    actor_login: "octocat",
    run_after: T,
    attempts: 0,
    runner_id: null,
    lease_token: null,
    claimed_at: null,
    heartbeat_at: null,
    lease_expires_at: null,
    result: null,
    error_code: null,
    superseded_by: null,
    created_at: T,
    updated_at: T,
    finished_at: null,
  };
  await db
    .insertInto("jobs")
    .values([
      {
        ...base,
        id: "j-queued",
        status: "queued",
        delivery_id: "delivery-queued",
      },
      {
        ...base,
        id: "j-running",
        status: "running",
        pr_number: 8,
        delivery_id: "delivery-running",
        runner_id: "runner-1",
        lease_token: "lease-1",
        claimed_at: T,
        heartbeat_at: T,
        lease_expires_at: T,
      },
      {
        ...base,
        id: "j-done",
        status: "succeeded",
        pr_number: 9,
        delivery_id: "delivery-done",
        result: "{}",
        finished_at: T,
      },
    ])
    .execute();
}

describe("the queue migration of the review kind", () => {
  // #195-T03
  it("backfills every waiting, running and finished job as Diff and keeps the delivery id", async () => {
    const db = await openPreviousReleaseDatabase();
    try {
      await seed(db);
      // The previous release's schema has no review_kind column.
      const columnsBefore = await db
        .selectFrom("jobs")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(columnsBefore).not.toHaveProperty("review_kind");

      const outcome = await migrateToLatest(db);
      expect(outcome.executed).toContain(SPLIT);

      const rows = await db
        .selectFrom("jobs")
        .selectAll()
        .orderBy("id")
        .execute();
      expect(rows.map((row) => row.review_kind)).toStrictEqual([
        "diff",
        "diff",
        "diff",
      ]);
      // Nothing else moved: statuses, results and delivery ids are intact.
      expect(rows.map((row) => row.status)).toStrictEqual([
        "succeeded",
        "queued",
        "running",
      ]);
      expect(rows.find((row) => row.id === "j-done")?.delivery_id).toBe(
        "delivery-done",
      );
      expect(rows.find((row) => row.id === "j-done")?.result).toBe("{}");
    } finally {
      await db.destroy();
    }
  });

  // #195-T03
  it("lets the same head hold one Diff and one Dynamic automatic job at a time", async () => {
    const db = await openPreviousReleaseDatabase();
    try {
      await seed(db);
      await migrateToLatest(db);
      const base = {
        workspace_id: "w-1",
        repository_id: "r-1",
        pr_number: 7,
        pr_url: "https://github.test/acme/widgets/pull/7",
        head_sha: "a".repeat(40),
        command: "review",
        args: "",
        trigger_kind: "webhook",
        actor_login: "octocat",
        delivery_id: null,
        status: "queued",
        run_after: T,
        attempts: 0,
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        result: null,
        error_code: null,
        superseded_by: null,
        created_at: T,
        updated_at: T,
        finished_at: null,
      };

      // A Dynamic automatic job for the same head as the migrated Diff job is a different job.
      await db
        .insertInto("jobs")
        .values({ ...base, id: "j-dynamic", review_kind: "dynamic" })
        .execute();
      // A second Diff automatic job for the same head is still refused.
      await expect(
        db
          .insertInto("jobs")
          .values({ ...base, id: "j-diff-2", review_kind: "diff" })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });
});
