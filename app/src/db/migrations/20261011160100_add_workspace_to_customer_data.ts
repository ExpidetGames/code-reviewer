// SPDX-License-Identifier: LicenseRef-Proprietary

// Puts the customer data into workspaces (docs/decisions/0001-editions-setup-and-accounts.md, sections
// 2.6, 2.7 and 2.10): `integrations`, `repositories`, `jobs` and `app_settings` (the review defaults)
// get a required `workspace_id`. A project belongs to a workspace through its repository.
//
// A database that already holds data gets ONE workspace, named "Default workspace" (slug "default"),
// and everything moves into it with every row kept. A database without data gets no workspace: the
// first-run setup creates it. "Holds data" means a row in `users`, `integrations`, `repositories`,
// `projects`, `jobs` or `app_settings`. The migration creates NO membership: who becomes a member is
// decided by the import of an existing installation, which looks at the allow list of the time.
//
// Why the tables are rebuilt: SQLite cannot add a NOT NULL column that references another table, and
// a nullable `workspace_id` would let a row exist that no workspace can see. The usual recipe (turn
// foreign keys off, rebuild, turn them on) does not work inside the migration transaction, where
// `PRAGMA foreign_keys` is a no-op. So the tables are rebuilt parents first, in a chain, and each new
// table is created against the NEW tables before any old table is dropped:
//
//   for T in integrations, repositories, projects, jobs, job_comments:
//     rename T to T_old          (SQLite re-points the foreign keys of the old children to T_old)
//     create T                   (its foreign keys point at the new parents, which are already built)
//     copy T_old into T
//   then drop the old tables, leaf first, and create the indexes (their names are free by then).
//
// No old table is dropped while a table refers to it, so no foreign key is ever violated and nothing
// has to be deferred. If any step fails, the whole start is rolled back (see ../migrate.ts).
//
// Two composite foreign keys make the database itself refuse a link across workspaces: a repository
// must name an integration of its own workspace, and a job a repository of its own workspace. That is
// why `integrations` and `repositories` have a unique index on (id, workspace_id).
//
// The unique index (type, external_id) of `integrations` stays global on purpose: one installation
// can be linked to one workspace only (decision record, section 2.9).
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { formatTimestamp } from "../codecs.ts";

/** The tables that hold data a workspace owns or a user created; any row in them means "has data". */
const TABLES_THAT_MAKE_AN_INSTALLATION = [
  "users",
  "integrations",
  "repositories",
  "projects",
  "jobs",
  "app_settings",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a migration must not depend on the current schema types.
type AnyDb = Kysely<any>;

async function installationHoldsData(db: AnyDb): Promise<boolean> {
  for (const table of TABLES_THAT_MAKE_AN_INSTALLATION) {
    const { rows } = await sql<{
      found: number;
    }>`select 1 as found from ${sql.table(table)} limit 1`.execute(db);
    if (rows.length > 0) return true;
  }
  return false;
}

async function renameToOld(db: AnyDb, table: string): Promise<void> {
  await sql`alter table ${sql.table(table)} rename to ${sql.table(`${table}_old`)}`.execute(
    db,
  );
}

/** The unique target of the composite foreign keys of `repositories` and `jobs`. */
function createIntegrationsIdWorkspaceUnique(db: AnyDb): Promise<void> {
  return db.schema
    .createIndex("integrations_id_workspace_unique")
    .on("integrations")
    .columns(["id", "workspace_id"])
    .unique()
    .execute();
}

// Postgres keeps the name of an explicitly named constraint when its table is renamed, and the
// names of primary key constraints are schema-wide (each is backed by an index). The new
// `job_comments` below reuses the explicit name `job_comments_pk`, so the old one steps aside first.
// (The old `app_settings` primary key was auto-named `app_settings_pkey`, so it does not collide
// with the new explicit `app_settings_pk`.) SQLite has neither a schema-wide constraint namespace
// nor `alter table ... rename constraint`, so this runs on Postgres only.
async function onPostgres(db: AnyDb): Promise<boolean> {
  try {
    // Postgres-only catalog. On SQLite this fails as a statement error, which does not abort the
    // surrounding transaction.
    await sql`select 1 from pg_catalog.pg_class limit 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

async function freeConstraintName(
  db: AnyDb,
  postgres: boolean,
  table: string,
  from: string,
  to: string,
): Promise<void> {
  if (!postgres) return;
  await sql`alter table ${sql.table(table)} rename constraint ${sql.id(from)} to ${sql.id(to)}`.execute(
    db,
  );
}

export const migration: Migration = {
  async up(db) {
    const postgres = await onPostgres(db);
    const workspaceId = (await installationHoldsData(db)) ? randomUUID() : null;
    if (workspaceId !== null)
      await db
        .insertInto("workspaces")
        .values({
          id: workspaceId,
          name: "Default workspace",
          slug: "default",
          created_by: null,
          created_at: formatTimestamp(new Date()),
        })
        .execute();
    // With no workspace there is no row to copy, so the value is never bound to a column.
    const owner = workspaceId ?? "";

    // integrations
    await renameToOld(db, "integrations");
    await db.schema
      .createTable("integrations")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("type", "text", (column) => column.notNull())
      .addColumn("display_name", "text", (column) => column.notNull())
      .addColumn("external_id", "text", (column) => column.notNull())
      .addColumn("config", "text", (column) => column.notNull())
      .addColumn("credentials", "text")
      .addColumn("webhook_secret", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
    await sql`
      insert into integrations (id, workspace_id, type, display_name, external_id, config, credentials,
                                webhook_secret, status, created_at, updated_at)
      select id, ${owner}, type, display_name, external_id, config, credentials,
             webhook_secret, status, created_at, updated_at
      from integrations_old`.execute(db);

    // Postgres refuses a foreign key whose target has no matching unique constraint, so the index
    // below must exist before `repositories` (with its composite FK) is created. SQLite only checks
    // at insert, and its schema object order is frozen: create the index here on Postgres only, and
    // in its shipped place (after `repositories`) on SQLite.
    if (postgres) await createIntegrationsIdWorkspaceUnique(db);

    // repositories
    await renameToOld(db, "repositories");
    await db.schema
      .createTable("repositories")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("integration_id", "text", (column) => column.notNull())
      .addColumn("external_id", "text", (column) => column.notNull())
      .addColumn("full_name", "text", (column) => column.notNull())
      .addColumn("url", "text", (column) => column.notNull())
      .addColumn("active", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint(
        "repositories_integration_fk",
        ["integration_id", "workspace_id"],
        "integrations",
        ["id", "workspace_id"],
      )
      .execute();
    // The target of the composite foreign keys must be unique; it has to exist before rows are
    // inserted into a table that refers to it. (On Postgres it was already created above, before
    // `repositories`, because the FK needs it then.)
    if (!postgres) await createIntegrationsIdWorkspaceUnique(db);
    await sql`
      insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active,
                                created_at, updated_at)
      select id, ${owner}, integration_id, external_id, full_name, url, active, created_at, updated_at
      from repositories_old`.execute(db);

    // projects (no new column: a project belongs to a workspace through its repository)
    await renameToOld(db, "projects");
    await db.schema
      .createIndex("repositories_id_workspace_unique")
      .on("repositories")
      .columns(["id", "workspace_id"])
      .unique()
      .execute();
    await db.schema
      .createTable("projects")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("repository_id", "text", (column) =>
        column.notNull().unique().references("repositories.id"),
      )
      .addColumn("active", "integer", (column) => column.notNull())
      // JSON text: the project's setting overrides, '{}' until some are saved.
      .addColumn("settings", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
    await sql`
      insert into projects (id, repository_id, active, settings, created_at, updated_at)
      select id, repository_id, active, settings, created_at, updated_at
      from projects_old`.execute(db);

    // jobs
    await renameToOld(db, "jobs");
    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("repository_id", "text", (column) => column.notNull())
      .addColumn("pr_number", "integer", (column) => column.notNull())
      .addColumn("pr_url", "text", (column) => column.notNull())
      .addColumn("head_sha", "text", (column) => column.notNull())
      .addColumn("command", "text", (column) => column.notNull())
      .addColumn("args", "text", (column) => column.notNull())
      .addColumn("trigger_kind", "text", (column) => column.notNull())
      .addColumn("actor_login", "text", (column) => column.notNull())
      .addColumn("delivery_id", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("run_after", "text", (column) => column.notNull())
      .addColumn("attempts", "integer", (column) => column.notNull())
      .addColumn("runner_id", "text")
      .addColumn("lease_token", "text")
      .addColumn("claimed_at", "text")
      .addColumn("heartbeat_at", "text")
      .addColumn("lease_expires_at", "text")
      .addColumn("result", "text")
      .addColumn("error_code", "text")
      .addColumn("superseded_by", "text", (column) =>
        column.references("jobs.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("finished_at", "text")
      .addForeignKeyConstraint(
        "jobs_repository_fk",
        ["repository_id", "workspace_id"],
        "repositories",
        ["id", "workspace_id"],
      )
      .execute();
    await sql`
      insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args,
                        trigger_kind, actor_login, delivery_id, status, run_after, attempts, runner_id,
                        lease_token, claimed_at, heartbeat_at, lease_expires_at, result, error_code,
                        superseded_by, created_at, updated_at, finished_at)
      select id, ${owner}, repository_id, pr_number, pr_url, head_sha, command, args,
             trigger_kind, actor_login, delivery_id, status, run_after, attempts, runner_id,
             lease_token, claimed_at, heartbeat_at, lease_expires_at, result, error_code,
             superseded_by, created_at, updated_at, finished_at
      from jobs_old`.execute(db);

    // job_comments
    await renameToOld(db, "job_comments");
    await freeConstraintName(
      db,
      postgres,
      "job_comments_old",
      "job_comments_pk",
      "job_comments_old_pk",
    );
    await db.schema
      .createTable("job_comments")
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      // The platform's id of the comment, as text.
      .addColumn("comment_id", "text", (column) => column.notNull())
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("jobs.id"),
      )
      .addPrimaryKeyConstraint("job_comments_pk", [
        "repository_id",
        "comment_id",
      ])
      .execute();
    await sql`
      insert into job_comments (repository_id, comment_id, job_id)
      select repository_id, comment_id, job_id from job_comments_old`.execute(
      db,
    );

    // app_settings: the review defaults are per workspace, so the key is unique per workspace.
    await renameToOld(db, "app_settings");
    await db.schema
      .createTable("app_settings")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("key", "text", (column) => column.notNull())
      // JSON text.
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("updated_by", "text")
      .addPrimaryKeyConstraint("app_settings_pk", ["workspace_id", "key"])
      .execute();
    await sql`
      insert into app_settings (workspace_id, key, value, updated_at, updated_by)
      select ${owner}, key, value, updated_at, updated_by from app_settings_old`.execute(
      db,
    );

    // Dropping a table deletes its rows first, and for every row SQLite looks for rows that refer to
    // it. `jobs_old` refers to itself through `superseded_by`, which has no index, so without this one
    // every deleted job scans the whole table: 10 000 jobs with 2 KB results took 44 seconds, with the
    // index 0.4. The other old tables have no child left at this point (they go leaf first).
    await db.schema
      .createIndex("jobs_old_superseded_by")
      .on("jobs_old")
      .column("superseded_by")
      .execute();

    // The old tables go, leaf first: nothing refers to them any more except tables that are gone.
    for (const table of [
      "job_comments_old",
      "jobs_old",
      "projects_old",
      "repositories_old",
      "integrations_old",
      "app_settings_old",
    ])
      await db.schema.dropTable(table).execute();

    // Indexes. The first six are the ones the tables had before, unchanged.
    await db.schema
      .createIndex("integrations_type_external_id_unique")
      .on("integrations")
      .columns(["type", "external_id"])
      .unique()
      .execute();
    await db.schema
      .createIndex("repositories_integration_external_id_unique")
      .on("repositories")
      .columns(["integration_id", "external_id"])
      .unique()
      .execute();
    await db.schema
      .createIndex("jobs_delivery_id_unique")
      .on("jobs")
      .column("delivery_id")
      .unique()
      .execute();
    await db.schema
      .createIndex("jobs_automatic_per_head_unique")
      .on("jobs")
      .columns(["repository_id", "pr_number", "head_sha", "command"])
      .unique()
      .where(
        sql<boolean>`trigger_kind = ${sql.lit("webhook")} and status in (${sql.lit("queued")}, ${sql.lit("running")}, ${sql.lit("succeeded")}, ${sql.lit("failed")})`,
      )
      .execute();
    await db.schema
      .createIndex("jobs_one_running_per_pull_request_unique")
      .on("jobs")
      .columns(["repository_id", "pr_number"])
      .unique()
      .where(sql.ref("status"), "=", "running")
      .execute();
    await db.schema
      .createIndex("jobs_status_run_after")
      .on("jobs")
      .columns(["status", "run_after"])
      .execute();
    await db.schema
      .createIndex("jobs_pull_request")
      .on("jobs")
      .columns(["repository_id", "pr_number", "command"])
      .execute();
    await db.schema
      .createIndex("jobs_repository_recent")
      .on("jobs")
      .columns(["repository_id", "created_at", "id"])
      .execute();
    await db.schema
      .createIndex("job_comments_job")
      .on("job_comments")
      .column("job_id")
      .execute();

    // New: every query of a workspace starts from its workspace id.
    await db.schema
      .createIndex("integrations_workspace")
      .on("integrations")
      .column("workspace_id")
      .execute();
    await db.schema
      .createIndex("repositories_workspace")
      .on("repositories")
      .column("workspace_id")
      .execute();
    // The runs pages list the newest jobs of a workspace.
    await db.schema
      .createIndex("jobs_workspace_recent")
      .on("jobs")
      .columns(["workspace_id", "created_at", "id"])
      .execute();
  },
};
