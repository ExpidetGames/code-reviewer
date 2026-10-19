// SPDX-License-Identifier: Apache-2.0

// #491: the billing plan migrations are gone from `development`. They never reached `main`, so a database of the last
// release must migrate to latest, and so must a fresh one, on SQLite and on Postgres, with none of the billing plan
// tables. A database that ran `development` while the three migrations existed has them recorded without a file: the
// migrator refuses it, and the reset documented in src/db/README.md ("A database that ran the removed billing
// migrations") makes it migrate again. The names of the removed tables and migrations are built from parts: nothing
// else in the repository names that vendor's design.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import {
  createTestDirectory,
  track,
} from "../../test-support/test-database.ts";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";

/** The migrations of `main`: everything a database of the last release has run, newest last. */
const MAIN_MIGRATIONS = [
  "0001_create_app_meta",
  "20261010123800_create_auth_tables",
  "20261010125500_add_user_org_checked_at",
  "20261010131500_add_user_org_checked_for",
  "20261010133000_create_allowed_login_pins",
  "20261010134000_create_integrations",
  "20261010143000_create_repositories",
  "20261010170000_create_webhook_deliveries",
  "20261010190000_create_projects",
  "20261010191500_create_jobs",
  "20261010201500_create_app_settings",
  "20261011090000_create_job_comments",
  "20261011100000_add_jobs_repository_recent_index",
  "20261011160000_create_workspaces",
  "20261011160100_add_workspace_to_customer_data",
  "20261011160200_prepare_users_for_accounts",
  "20261011170000_create_instance_settings",
  "20261011170100_create_rate_limits",
  "20261011170200_add_instance_admin_flag_to_users",
  "20261011200000_create_secrets",
  "20261011200100_create_password_reset_tokens",
  "20261011210000_create_email_verification_tokens",
  "20261012100000_create_invitations",
  "20261012120000_create_signed_states",
  "20261012120100_add_users_email_conflict",
  "20261012120200_unique_accounts",
  "20261012140000_create_workspace_secrets",
  "20261012140100_create_job_claimed_keys",
  "20261012150000_create_installation_binding",
  "20261012160000_remove_commands",
  "20261013090000_add_job_review_kind",
  "20261014090000_fix_dynamic_default_model",
  "20261014120000_create_workspace_entitlements",
  "20261014150000_create_usage_records",
  "20261015100000_add_job_worker_fetches",
  "20261015110000_create_setup_codes",
  "20261015120000_create_job_dispatches",
  "20261015200000_add_usage_record_settled_reason",
  "20261016090000_create_refusal_notices",
  "20261016120000_create_plan_handoff_tokens",
  "20261016140000_add_job_accepts_supersede",
  "20261016140100_widen_usage_record_settled_reason",
] as const;

/** The migrations that `development` has and `main` has not, and that stay. They run in this order after main's. */
const SINCE_MAIN = [
  "20261017100000_create_job_check_runs",
  "20261017140000_create_model_catalog_entries",
  "20261017160000_add_workspace_entitlements_model_access",
  "20261018090000_add_usage_record_catalog_entry",
  "20261018170000_migrate_model_tiers_to_catalog",
] as const;

const REMOVED_MIGRATIONS = [
  "20261018120000_create_billing_plans",
  "20261018140000_protect_billing_plan_versions",
  "20261018160000_create_billing_plan_prices",
];
/** In the order of the documented reset: the tables that point at another go first. */
const REMOVED_TABLES = [
  "billing_plan_prices",
  "billing_plan_versions",
  "billing_plans",
];

/** The reset of src/db/README.md, as statements. */
const RESET_STATEMENTS = [
  ...REMOVED_TABLES.map((table) => `drop table ${table}`),
  `delete from kysely_migration where name in (${REMOVED_MIGRATIONS.map((name) => `'${name}'`).join(", ")})`,
];

const T = "2026-10-18T08:00:00.000Z";

const upToMain: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(([name]) =>
        (MAIN_MIGRATIONS as readonly string[]).includes(name),
      ),
    );
  },
};

type Engine = {
  name: "sqlite" | "postgres";
  /** An empty database that is not migrated. */
  open: () => Promise<Kysely<Database>>;
};

const sqlite: Engine = {
  name: "sqlite",
  open: async () => {
    const directory = await createTestDirectory();
    return track(
      openDatabase({
        driver: "sqlite",
        path: `${directory}/app.db`,
        busyTimeoutMs: 5000,
      }),
    );
  },
};

const postgres: Engine = {
  name: "postgres",
  open: async () => (await createPostgresTestDatabase({ migrate: false })).db,
};

const engines: Engine[] = hasPostgres() ? [sqlite, postgres] : [sqlite];

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  return (await db.introspection.getTables()).map((table) => table.name);
}

async function recorded(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`select name from kysely_migration order by name`.execute(db);
  return rows.map((row) => row.name);
}

describe.each(engines)("the migrations on $name", ({ open }) => {
  // #491-T02
  it("take an empty database to latest without a billing plan table", async () => {
    const db = await open();

    const { executed } = await migrateToLatest(db);

    expect(executed).toEqual(
      Object.keys(await migrationProvider.getMigrations()).sort(),
    );
    expect(executed.slice(0, MAIN_MIGRATIONS.length)).toEqual([
      ...MAIN_MIGRATIONS,
    ]);
    expect(
      executed.slice(
        MAIN_MIGRATIONS.length,
        MAIN_MIGRATIONS.length + SINCE_MAIN.length,
      ),
    ).toEqual([...SINCE_MAIN]);
    const tables = await tableNames(db);
    for (const table of REMOVED_TABLES) expect(tables).not.toContain(table);
    expect(await recorded(db)).toEqual(executed);
  });

  // #491-T03
  it("take a database at the schema of main, with data in it, to latest and keep every row", async () => {
    const db = await open();
    expect((await migrateToLatest(db, upToMain)).executed).toEqual([
      ...MAIN_MIGRATIONS,
    ]);
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
    await db
      .insertInto("projects")
      .values({
        id: "p-1",
        repository_id: "r-1",
        active: 1,
        settings: '{"reviewKind":"diff"}',
        created_at: T,
        updated_at: T,
      })
      .execute();
    await db
      .insertInto("jobs")
      .values({
        id: "j-1",
        workspace_id: "w-1",
        repository_id: "r-1",
        pr_number: 7,
        pr_url: "https://github.test/acme/widgets/pull/7",
        head_sha: "a".repeat(40),
        command: "review",
        args: "",
        trigger_kind: "webhook",
        actor_login: "octocat",
        delivery_id: "d-1",
        status: "succeeded",
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
        finished_at: T,
      })
      .execute();
    await sql`insert into workspace_entitlements
      (workspace_id, plan_label, key_mode, limits, period_start, suspended, suspension_code, updated_by, updated_at)
      values ('w-1', 'Team', 'managed', '{"diffRunsPerPeriod":5}', ${T}, 0, null, null, ${T})`.execute(
      db,
    );
    await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at, settled_at, settled_reason)
      values ('u-1', 'w-1', 'j-1', 'diff', 'own', 'settled', ${T}, ${T}, 'no_result')`.execute(
      db,
    );
    const tables = [
      "workspaces",
      "integrations",
      "repositories",
      "projects",
      "jobs",
      "workspace_entitlements",
      "usage_records",
    ] as const;
    const before = new Map<string, Array<Record<string, unknown>>>();
    for (const table of tables)
      before.set(
        table,
        (
          await sql<
            Record<string, unknown>
          >`select * from ${sql.table(table)}`.execute(db)
        ).rows,
      );

    const { executed } = await migrateToLatest(db);

    expect(executed.slice(0, SINCE_MAIN.length)).toEqual([...SINCE_MAIN]);
    for (const table of tables) {
      const after = (
        await sql<
          Record<string, unknown>
        >`select * from ${sql.table(table)}`.execute(db)
      ).rows;
      const old = before.get(table) ?? [];
      expect(after, table).toHaveLength(old.length);
      expect(old.length, table).toBeGreaterThan(0);
      // A column the upgrade added is new; every column the row had keeps its value.
      for (const [index, row] of old.entries())
        expect(after[index], table).toMatchObject(row);
    }
    const names = await tableNames(db);
    expect(names).toContain("model_catalog_entries");
    expect(names).toContain("job_check_runs");
    for (const table of REMOVED_TABLES) expect(names).not.toContain(table);
  });

  // #491-T04
  it("refuse a database that recorded a removed migration, and take it after the documented reset", async () => {
    const db = await open();
    await migrateToLatest(db);
    // What a database that ran `development` while the three migrations existed holds on top: their tables (shape
    // reduced to what the reset touches) and their records. The record of a later migration stays.
    await sql`create table billing_plans (id text primary key)`.execute(db);
    await sql`create table billing_plan_versions (id text primary key, plan_id text references billing_plans (id))`.execute(
      db,
    );
    await sql`create table billing_plan_prices (id text primary key, plan_id text references billing_plans (id))`.execute(
      db,
    );
    for (const name of REMOVED_MIGRATIONS)
      await sql`insert into kysely_migration (name, timestamp) values (${name}, ${T})`.execute(
        db,
      );

    const refused = migrateToLatest(db);

    await expect(refused).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    await expect(refused).rejects.toThrow(REMOVED_MIGRATIONS[0] ?? "");

    for (const statement of RESET_STATEMENTS)
      await sql.raw(statement).execute(db);

    expect((await migrateToLatest(db)).executed).toEqual([]);
    expect(await recorded(db)).toEqual(
      Object.keys(await migrationProvider.getMigrations()).sort(),
    );
    for (const table of REMOVED_TABLES)
      expect(await tableNames(db)).not.toContain(table);
  });
});
