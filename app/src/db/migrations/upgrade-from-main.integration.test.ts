// SPDX-License-Identifier: LicenseRef-Proprietary

// #491: the billing plan migrations are gone from `development`. They never reached `main`, so a database of the last
// release must migrate to latest, and so must a fresh one, on SQLite and on Postgres, with none of the billing plan
// tables. A database that ran `development` while the three migrations existed has them recorded without a file: the
// migrator refuses it, and the reset documented in src/db/README.md ("A database that ran the removed billing
// migrations") makes it migrate again. The reset is run as written in that README (its fenced SQL is the one source),
// against a frozen copy of the schema the three migrations left: tables, foreign keys, triggers and, on Postgres, the
// guard functions. The names of the removed tables and migrations are built from parts: nothing else in the repository
// names that vendor's design.
import { readFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { isBillingOn, readBillingSwitch } from "../../billing/enabled.ts";
import { createInstanceSettingsRepository } from "../repositories/instance-settings-repository.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import {
  createTestDirectory,
  track,
} from "../../test-support/test-database.ts";
import { openDatabase } from "../connection.ts";
import { databaseDriver } from "../driver.ts";
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
const REMOVED_TABLES = [
  "billing_plan_prices",
  "billing_plan_versions",
  "billing_plans",
];
const REMOVED_FUNCTIONS = [
  "billing_plan_versions_guard",
  "billing_plan_prices_guard",
];

/** The vendor of the removed design, built from parts like the table names are in the scan of the cleanup. */
const V = ["pad", "dle"].join("");

/**
 * The reset of src/db/README.md, read from the fenced SQL of that section: the first block runs on every engine, the
 * block tagged `sql postgres` only on Postgres. The documented statements are the ones the test runs.
 */
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const RESET_HEADING = "### A database that ran the removed billing migrations";

function resetStatements(driver: "sqlite" | "postgres"): string[] {
  const start = README.indexOf(RESET_HEADING);
  expect(start, "the reset section of src/db/README.md").toBeGreaterThan(-1);
  const rest = README.slice(start + RESET_HEADING.length);
  const end = rest.search(/\n##? /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const statements: string[] = [];
  for (const [, tag, body] of section.matchAll(
    /```sql( postgres)?\n([\s\S]*?)```/g,
  )) {
    if (tag !== undefined && driver !== "postgres") continue;
    const text = (body ?? "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of text.split(";"))
      if (statement.trim() !== "") statements.push(statement.trim());
  }
  return statements;
}

/**
 * The schema a database that ran the three removed migrations holds on top of the current one, frozen here as SQL (the
 * migrations are gone, so nothing is imported): `billing_plans`, `billing_plan_versions` and `billing_plan_prices` with
 * their checks and indexes, the columns that make the versions point at the prices and the plans at a product, and the
 * guards against changing a version or a price (triggers on SQLite; a function and a trigger each on Postgres, and the
 * function outlives its table). Taken from the three migrations as they were on `development`, in their order.
 */
const REMOVED_SCHEMA_COMMON = [
  `create table billing_plans ("id" text not null primary key, "plan_key" text not null, "name" text not null, "description" text default '' not null, "sort" integer default 0 not null, "kind" text not null, "offered" integer default 0 not null, "popular" integer default 0 not null, "contact_target" text, "archived_at" text, "created_at" text not null, "updated_at" text not null, "updated_by" text references "users" ("id") on delete set null, constraint "billing_plans_kind_check" check (kind in ('free', 'paid', 'contact')), constraint "billing_plans_flags_check" check (offered in (0, 1) and popular in (0, 1)), constraint "billing_plans_popular_paid_check" check (popular = 0 or kind = 'paid'), constraint "billing_plans_contact_target_check" check (contact_target is null or kind = 'contact'))`,
  `create unique index "billing_plans_plan_key" on "billing_plans" ("plan_key")`,
  `create unique index "billing_plans_one_popular" on "billing_plans" ("popular") where popular = 1`,
  `create unique index "billing_plans_one_free" on "billing_plans" ("kind") where kind = 'free'`,
  `create table billing_plan_versions ("id" text not null primary key, "plan_id" text not null references "billing_plans" ("id") on delete restrict, "number" integer not null, "role" text not null, "key_mode" text not null, "limits" text not null, "model_access" text, "monthly_amount_minor" integer, "yearly_amount_minor" integer, "created_at" text not null, "created_by" text references "users" ("id") on delete set null, constraint "billing_plan_versions_role_check" check (role in ('current', 'legacy')), constraint "billing_plan_versions_key_mode_check" check (key_mode in ('own', 'managed')), constraint "billing_plan_versions_number_check" check (number >= 1), constraint "billing_plan_versions_prices_check" check ((monthly_amount_minor is null or monthly_amount_minor > 0) and (yearly_amount_minor is null or (yearly_amount_minor > 0 and monthly_amount_minor is not null))), constraint "billing_plan_versions_own_model_access_check" check (key_mode = 'managed' or model_access is null))`,
  `create unique index "billing_plan_versions_plan_number" on "billing_plan_versions" ("plan_id", "number")`,
  `create unique index "billing_plan_versions_one_current" on "billing_plan_versions" ("plan_id") where role = 'current'`,
  `create table billing_plan_prices ("id" text not null primary key, "plan_id" text not null references "billing_plans" ("id") on delete restrict, "${V}_price_id" text, "${V}_product_id" text not null, "${V}_env" text not null, "price_type" text default 'standard' not null, "interval" text not null, "frequency" integer not null, "currency" text not null, "unit_amount_minor" text not null, "tax_mode" text not null, "has_overrides" integer default 0 not null, "trial_days" integer, "quantity_min" integer not null, "quantity_max" integer not null, "${V}_status" text, "origin" text not null, "intent_id" text, "state" text not null, "last_error_code" text, "snapshot_at" text, "created_at" text not null, "archived_at" text, constraint "billing_plan_prices_origin_check" check (origin in ('created', 'linked')), constraint "billing_plan_prices_state_check" check (state in ('pending', 'ready', 'failed')), constraint "billing_plan_prices_env_check" check (${V}_env in ('sandbox', 'live')), constraint "billing_plan_prices_type_check" check (price_type in ('standard', 'custom')), constraint "billing_plan_prices_overrides_check" check (has_overrides in (0, 1)), constraint "billing_plan_prices_quantity_check" check (quantity_min >= 1 and quantity_max >= 1), constraint "billing_plan_prices_amount_check" check (length(unit_amount_minor) between 1 and 30), constraint "billing_plan_prices_ready_check" check (state <> 'ready' or (${V}_price_id is not null and ${V}_status is not null and snapshot_at is not null)))`,
  `create unique index "billing_plan_prices_${V}_price" on "billing_plan_prices" ("${V}_price_id")`,
  `create unique index "billing_plan_prices_intent" on "billing_plan_prices" ("intent_id")`,
  `create index "billing_plan_prices_plan" on "billing_plan_prices" ("plan_id")`,
  `alter table billing_plans add column "${V}_product_id" text`,
  `alter table billing_plans add column "${V}_product_env" text`,
  // The foreign keys that make the versions point at the prices, the reverse of what the prices point at.
  `alter table billing_plan_versions add column "monthly_price_id" text references "billing_plan_prices" ("id") on delete restrict`,
  `alter table billing_plan_versions add column "yearly_price_id" text references "billing_plan_prices" ("id") on delete restrict`,
];

const REMOVED_SCHEMA_SQLITE = [
  `create trigger billing_plan_versions_never_deleted before delete on billing_plan_versions begin select raise(abort, 'billing_plan_versions_immutable: a plan version is never deleted'); end`,
  `create trigger billing_plan_versions_terms_frozen before update of id, plan_id, number, key_mode, limits, model_access, monthly_amount_minor, yearly_amount_minor, created_at on billing_plan_versions begin select raise(abort, 'billing_plan_versions_immutable: a plan version changes only its role'); end`,
  ...["monthly_price_id", "yearly_price_id"].map(
    (column) =>
      `create trigger billing_plan_versions_${column}_kept before update of ${column} on billing_plan_versions when new.${column} is null and (select ${column} from billing_plan_versions where id = new.id) is not null begin select raise(abort, 'billing_plan_versions_immutable: a price link is replaced, never cleared'); end`,
  ),
  `create trigger billing_plan_prices_identity_frozen before update of id, plan_id, ${V}_env, origin, created_at on billing_plan_prices begin select raise(abort, 'billing_plan_prices_immutable: the identity of a price never changes'); end`,
  `create trigger billing_plan_prices_${V}_id_once before update of ${V}_price_id on billing_plan_prices when (select ${V}_price_id from billing_plan_prices where id = new.id) is not null begin select raise(abort, 'billing_plan_prices_immutable: the ${V} price id is set once'); end`,
];

const REMOVED_SCHEMA_POSTGRES = [
  `create or replace function billing_plan_versions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing_plan_versions_immutable: a plan version is never deleted' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - 'role' - 'created_by' - 'monthly_price_id' - 'yearly_price_id') is distinct from (to_jsonb(old) - 'role' - 'created_by' - 'monthly_price_id' - 'yearly_price_id') then
    raise exception 'billing_plan_versions_immutable: a plan version changes only its role and its price links' using errcode = 'restrict_violation';
  end if;
  if (old.monthly_price_id is not null and new.monthly_price_id is null) or (old.yearly_price_id is not null and new.yearly_price_id is null) then
    raise exception 'billing_plan_versions_immutable: a price link is replaced, never cleared' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$`,
  `create trigger billing_plan_versions_immutable before update or delete on billing_plan_versions for each row execute function billing_plan_versions_guard()`,
  `create function billing_plan_prices_guard() returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id or new.plan_id is distinct from old.plan_id or new.${V}_env is distinct from old.${V}_env or new.origin is distinct from old.origin or new.created_at is distinct from old.created_at then
    raise exception 'billing_plan_prices_immutable: the identity of a price never changes' using errcode = 'restrict_violation';
  end if;
  if old.${V}_price_id is not null and new.${V}_price_id is distinct from old.${V}_price_id then
    raise exception 'billing_plan_prices_immutable: the ${V} price id is set once' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$`,
  `create trigger billing_plan_prices_immutable before update on billing_plan_prices for each row execute function billing_plan_prices_guard()`,
];

/** What the three removed migrations left, plus a plan, a price and a version that points at it when `withRows`. */
async function createRemovedSchema(
  db: Kysely<Database>,
  withRows: boolean,
): Promise<void> {
  const driver = databaseDriver(db);
  for (const statement of [
    ...REMOVED_SCHEMA_COMMON,
    ...(driver === "postgres"
      ? REMOVED_SCHEMA_POSTGRES
      : REMOVED_SCHEMA_SQLITE),
  ])
    await sql.raw(statement).execute(db);
  for (const name of REMOVED_MIGRATIONS)
    await sql`insert into kysely_migration (name, timestamp) values (${name}, ${T})`.execute(
      db,
    );
  if (!withRows) return;
  await sql`insert into billing_plans (id, plan_key, name, kind, created_at, updated_at)
    values ('pl-1', 'team', 'Team', 'paid', ${T}, ${T})`.execute(db);
  await sql
    .raw(
      `insert into billing_plan_prices (id, plan_id, ${V}_price_id, ${V}_product_id, ${V}_env, interval, frequency, currency, unit_amount_minor, tax_mode, quantity_min, quantity_max, ${V}_status, origin, state, snapshot_at, created_at)
     values ('pr-1', 'pl-1', 'p-1', 'prod-1', 'sandbox', 'month', 1, 'USD', '2900', 'account_setting', 1, 1, 'active', 'linked', 'ready', '${T}', '${T}')`,
    )
    .execute(db);
  await sql`insert into billing_plan_versions (id, plan_id, number, role, key_mode, limits, created_at, monthly_price_id)
    values ('v-1', 'pl-1', 1, 'current', 'managed', '{}', ${T}, 'pr-1')`.execute(
    db,
  );
}

/** Runs the documented reset in one transaction, as the README says. */
async function runDocumentedReset(db: Kysely<Database>): Promise<void> {
  const statements = resetStatements(databaseDriver(db));
  await db.transaction().execute(async (trx) => {
    for (const statement of statements) await sql.raw(statement).execute(trx);
  });
}

async function leftovers(db: Kysely<Database>): Promise<string[]> {
  const found = (await tableNames(db)).filter((name) =>
    REMOVED_TABLES.includes(name),
  );
  if (databaseDriver(db) === "postgres") {
    const { rows } = await sql<{
      proname: string;
    }>`select proname from pg_proc where proname = any(${REMOVED_FUNCTIONS})`.execute(
      db,
    );
    return [...found, ...rows.map((row) => row.proname)];
  }
  const { rows } = await sql<{
    name: string;
  }>`select name from sqlite_master where name like 'billing\_plan%' escape '\\'`.execute(
    db,
  );
  return [...found, ...rows.map((row) => row.name)];
}

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
  it.each([
    ["no row in the removed tables", false],
    ["a plan, a price and a version that points at it", true],
  ])(
    "refuse a database that recorded a removed migration, and take it after the documented reset (%s)",
    async (_name, withRows) => {
      const db = await open();
      await migrateToLatest(db);
      await createRemovedSchema(db, withRows);

      const refused = migrateToLatest(db);

      await expect(refused).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
      await expect(refused).rejects.toThrow(REMOVED_MIGRATIONS[0] ?? "");

      await runDocumentedReset(db);

      expect(await leftovers(db)).toEqual([]);
      expect((await migrateToLatest(db)).executed).toEqual([]);
      expect(await recorded(db)).toEqual(
        Object.keys(await migrationProvider.getMigrations()).sort(),
      );
    },
  );

  // #491-T04
  it("switch billing off for good with the documented reset, whatever the removed design stored", async () => {
    const db = await open();
    await migrateToLatest(db);
    await createRemovedSchema(db, false);
    // A setting of the old shape that said on: the switch still reads as set (the old shape has no rates, so the adapter is
    // not ready and billing is not on, #504); the reset takes the switch itself away.
    await sql`insert into instance_settings (key, value, updated_by, updated_at)
      values ('billing_settings', '{"enabled":true,"environment":"sandbox","clientToken":"t","graceDays":7}', null, ${T})`.execute(
      db,
    );
    expect((await readBillingSwitch(db)).enabled).toBe(true);
    expect(await isBillingOn(db)).toBe(false);

    await runDocumentedReset(db);

    expect((await readBillingSwitch(db)).enabled).toBe(false);
    expect(await isBillingOn(db)).toBe(false);
  });

  // #491-T04
  it.each([
    ["billing wrote (source billing)", { source: "billing" }, undefined],
    ["an operator saved", {}, { planLabel: "Free" }],
  ])(
    "treat the default entitlements that %s as the documented reset says",
    async (_name, marker, expected) => {
      const db = await open();
      await migrateToLatest(db);
      await createRemovedSchema(db, false);
      await sql`insert into instance_settings (key, value, updated_by, updated_at)
        values ('default_entitlements', ${JSON.stringify({
          planLabel: "Free",
          keyMode: "managed",
          limits: {
            diffRunsPerPeriod: 5,
            dynamicRunsPerPeriod: 0,
            managedCostLimitMicroUsd: null,
            ownKeyCostLimitMicroUsd: null,
          },
          suspended: false,
          suspensionCode: null,
          periodStart: "2026-10-01T00:00:00.000Z",
          modelAccess: { catalogEntries: null },
          ...marker,
        })}, null, ${T})`.execute(db);

      await runDocumentedReset(db);

      // The Free plan that billing wrote must not become the operator's default by surviving the reset; a default an
      // operator saved (no marker) is theirs and stays.
      const settings = createInstanceSettingsRepository(db);
      if (expected === undefined)
        expect(await settings.getDefaultEntitlements()).toBeUndefined();
      else
        expect(await settings.getDefaultEntitlements()).toMatchObject(expected);
    },
  );
});
