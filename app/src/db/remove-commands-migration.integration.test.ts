// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the data migration that removes /ask, /improve and /describe (#203) against a real
// database: it cancels waiting removed commands with `command_removed` while keeping history and
// running jobs, and it intersects stored `allowedCommands` with the command that still exists without
// touching any other field. A failure rolls the whole start back, and a restart after a successful
// migration changes nothing and never resurrects a cancelled job.
import { sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import { createIntegrationsRepository } from "./repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories/repositories-repository.ts";
import { createEmptyTestDatabase } from "../test-support/test-database.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";

const REMOVE_COMMANDS = "20261012160000_remove_commands";

/** Every migration before the one under test, so the schema is the previous release's. */
const providerBefore: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < REMOVE_COMMANDS,
      ),
    );
  },
};

async function startPreviousRelease() {
  const db = (await createEmptyTestDatabase()).db;
  await migrateToLatest(db, providerBefore);
  const workspaceId = await defaultWorkspaceId(db);
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  await createRepositoriesRepository(db, workspaceId).reconcile(
    integration.id,
    [
      {
        integrationId: integration.id,
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
    ],
  );
  const [repository] = await createRepositoriesRepository(db, workspaceId).list(
    { integrationId: integration.id },
  );
  if (repository === undefined) throw new Error("no repository");
  return { db, workspaceId, repositoryId: repository.id };
}

type SeedJob = {
  command: string;
  status: string;
  args?: string;
  errorCode?: string | null;
  result?: string | null;
};

async function seedJobs(
  db: Awaited<ReturnType<typeof startPreviousRelease>>["db"],
  workspaceId: string,
  repositoryId: string,
  jobs: SeedJob[],
): Promise<void> {
  const timestamp = "2026-10-01T09:00:00.000Z";
  for (const [index, job] of jobs.entries()) {
    await db
      .insertInto("jobs")
      .values({
        id: `job-${String(index)}`,
        workspace_id: workspaceId,
        repository_id: repositoryId,
        pr_number: index + 1,
        pr_url: `https://github.test/acme/widgets/pull/${String(index + 1)}`,
        head_sha: String(index + 1)
          .repeat(40)
          .slice(0, 40),
        command: job.command,
        args: job.args ?? "",
        trigger_kind: "comment",
        actor_login: "octocat",
        delivery_id: null,
        status: job.status,
        run_after: timestamp,
        attempts: 0,
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        result: job.result ?? null,
        error_code: job.errorCode ?? null,
        superseded_by: null,
        created_at: timestamp,
        updated_at: timestamp,
        finished_at: null,
      })
      .execute();
  }
}

async function seedReviewDefaults(
  db: Awaited<ReturnType<typeof startPreviousRelease>>["db"],
  workspaceId: string,
  value: unknown,
): Promise<void> {
  await db
    .insertInto("app_settings")
    .values({
      workspace_id: workspaceId,
      key: "review_defaults",
      value: JSON.stringify(value),
      updated_at: "2026-10-01T09:00:00.000Z",
      updated_by: "octocat",
    })
    .execute();
}

async function seedProjectSettings(
  db: Awaited<ReturnType<typeof startPreviousRelease>>["db"],
  repositoryId: string,
  settings: unknown,
): Promise<void> {
  await db
    .insertInto("projects")
    .values({
      id: "project-1",
      repository_id: repositoryId,
      active: 1,
      settings: JSON.stringify(settings),
      created_at: "2026-10-01T09:00:00.000Z",
      updated_at: "2026-10-01T09:00:00.000Z",
    })
    .execute();
}

async function read<T>(
  db: Awaited<ReturnType<typeof startPreviousRelease>>["db"],
  query: string,
): Promise<T[]> {
  const { rows } = await sql.raw(query).execute(db);
  return rows as T[];
}

describe("the migration that removes the commands", () => {
  // #203-T08
  it("cancels waiting removed commands, keeps history and running jobs, and normalizes stored settings", async () => {
    const { db, workspaceId, repositoryId } = await startPreviousRelease();
    await seedJobs(db, workspaceId, repositoryId, [
      { command: "review", status: "queued" },
      { command: "improve", status: "queued" },
      { command: "describe", status: "queued", args: "" },
      { command: "ask", status: "queued", args: "why?" },
      { command: "improve", status: "running" },
      {
        command: "ask",
        status: "succeeded",
        args: "a question",
        result: JSON.stringify({ ok: true, commentUrl: "https://x/1" }),
      },
      { command: "describe", status: "failed", errorCode: "timeout" },
    ]);
    await seedReviewDefaults(db, workspaceId, {
      maxFindings: 7,
      allowedCommands: ["review", "ask"],
    });
    await seedProjectSettings(db, repositoryId, {
      maxFindings: 2,
      allowedCommands: ["ask"],
    });

    await migrateToLatest(db);

    const jobs = await read<{
      command: string;
      status: string;
      error_code: string | null;
      args: string;
      result: string | null;
      lease_expires_at: string | null;
    }>(
      db,
      "select command, status, error_code, args, result, lease_expires_at from jobs order by id",
    );
    expect(jobs).toEqual([
      // review queued: untouched
      {
        command: "review",
        status: "queued",
        error_code: null,
        args: "",
        result: null,
        lease_expires_at: null,
      },
      // improve queued: cancelled with the stable code, nothing else changed
      {
        command: "improve",
        status: "cancelled",
        error_code: "command_removed",
        args: "",
        result: null,
        lease_expires_at: null,
      },
      {
        command: "describe",
        status: "cancelled",
        error_code: "command_removed",
        args: "",
        result: null,
        lease_expires_at: null,
      },
      {
        command: "ask",
        status: "cancelled",
        error_code: "command_removed",
        args: "why?",
        result: null,
        lease_expires_at: null,
      },
      // running: left alone (it may finish under its lease)
      {
        command: "improve",
        status: "running",
        error_code: null,
        args: "",
        result: null,
        lease_expires_at: null,
      },
      // terminal: history kept, with its result and arguments
      {
        command: "ask",
        status: "succeeded",
        error_code: null,
        args: "a question",
        result: JSON.stringify({ ok: true, commentUrl: "https://x/1" }),
        lease_expires_at: null,
      },
      {
        command: "describe",
        status: "failed",
        error_code: "timeout",
        args: "",
        result: null,
        lease_expires_at: null,
      },
    ]);

    const defaults = await read<{ value: string }>(
      db,
      "select value from app_settings where key = 'review_defaults'",
    );
    expect(JSON.parse(defaults[0]?.value ?? "{}")).toEqual({
      maxFindings: 7,
      allowedCommands: ["review"],
    });
    const project = await read<{ settings: string }>(
      db,
      "select settings from projects where id = 'project-1'",
    );
    // An explicit list that only named a removed command stays empty, never `["review"]`.
    expect(JSON.parse(project[0]?.settings ?? "{}")).toEqual({
      maxFindings: 2,
      allowedCommands: [],
    });
  });

  // #203-T08
  it("leaves a settings layer that never named the commands and a missing field alone", async () => {
    const { db, workspaceId, repositoryId } = await startPreviousRelease();
    await seedReviewDefaults(db, workspaceId, {
      maxFindings: 7,
      extraInstructions: "be strict",
    });
    await seedProjectSettings(db, repositoryId, { maxFindings: 2 });

    await migrateToLatest(db);

    const defaults = await read<{ value: string }>(
      db,
      "select value from app_settings where key = 'review_defaults'",
    );
    expect(JSON.parse(defaults[0]?.value ?? "{}")).toEqual({
      maxFindings: 7,
      extraInstructions: "be strict",
    });
    const project = await read<{ settings: string }>(
      db,
      "select settings from projects where id = 'project-1'",
    );
    expect(JSON.parse(project[0]?.settings ?? "{}")).toEqual({
      maxFindings: 2,
    });
  });

  // #203-T09
  it("rolls back and refuses to start when the migration fails, and does nothing twice after a restart", async () => {
    const { db, workspaceId, repositoryId } = await startPreviousRelease();
    await seedJobs(db, workspaceId, repositoryId, [
      { command: "improve", status: "queued" },
    ]);
    await seedReviewDefaults(db, workspaceId, { allowedCommands: ["ask"] });

    // A failure after the migration's own work: everything must roll back.
    const failing: Migration = {
      async up(inner) {
        const real = await migrationProvider.getMigrations();
        await real[REMOVE_COMMANDS]?.up?.(inner);
        await sql`this is not valid sql`.execute(inner);
      },
    };
    const failingProvider: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await providerBefore.getMigrations()),
          [REMOVE_COMMANDS]: failing,
        };
      },
    };

    await expect(migrateToLatest(db, failingProvider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    expect(await read(db, "select status, error_code from jobs")).toEqual([
      { status: "queued", error_code: null },
    ]);
    expect(
      JSON.parse(
        (
          await read<{ value: string }>(
            db,
            "select value from app_settings where key = 'review_defaults'",
          )
        )[0]?.value ?? "{}",
      ),
    ).toEqual({ allowedCommands: ["ask"] });
    expect(
      await read(
        db,
        `select name from kysely_migration where name = '${REMOVE_COMMANDS}'`,
      ),
    ).toEqual([]);

    // The next start applies it once; a second start changes nothing and never restores a job.
    await migrateToLatest(db);
    const afterFirst = await read(db, "select status, error_code from jobs");
    expect(afterFirst).toEqual([
      { status: "cancelled", error_code: "command_removed" },
    ]);
    await migrateToLatest(db);
    expect(await read(db, "select status, error_code from jobs")).toEqual(
      afterFirst,
    );
  });
});
