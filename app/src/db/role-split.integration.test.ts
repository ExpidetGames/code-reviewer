// SPDX-License-Identifier: LicenseRef-Proprietary

// The two roles of the hosted deployment guide (docs/deployment-vercel.md, section 2), proven against a real Postgres (#333):
// the SQL of the guide is taken out of the guide itself and run as written (only the role names, the database name and the
// two passwords are made unique), `pnpm migrate` runs as the migrate role, and the app role can then read and write the
// tables but not change the schema. The repair statement of the guide fixes the tables that existed before the default
// privileges. Runs only when TEST_DATABASE_URL is set (a superuser or a role that may create roles and databases).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { checkHealth } from "../health/health.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import {
  hasPostgres,
  postgresTestUrl,
} from "../test-support/postgres-test-database.ts";
import { runMigrateCommand } from "./migrate-cli.ts";
import { openPostgresDatabase } from "./postgres.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const guide = readFileSync(`${repoRoot}docs/deployment-vercel.md`, "utf8");

/** The bodies of the `<<SQL ... SQL` heredocs of the guide, in order. */
function guideSql(): {
  roles: string;
  schema: string;
  defaults: string;
  repair: string;
} {
  const bodies = [...guide.matchAll(/<<SQL\n([\s\S]*?)\nSQL\n/g)].map(
    (match) => match[1] as string,
  );
  const pick = (needle: string): string => {
    const found = bodies.filter((body) => body.includes(needle));
    if (found.length !== 1)
      throw new Error(
        `the guide must have exactly one SQL block with "${needle}"`,
      );
    return found[0] as string;
  };
  return {
    roles: pick("create role"),
    schema: pick("revoke all on schema"),
    defaults: pick("alter default privileges"),
    repair: pick("on all tables in schema"),
  };
}

type Names = {
  migrate: string;
  app: string;
  database: string;
  migratePassword: string;
  appPassword: string;
};

/** The guide's SQL with the names of this test and real passwords (hex, like the guide's `openssl rand -hex 32`). */
function statements(sql: string, names: Names): string[] {
  return sql
    .replaceAll("$MIGRATE_PW", names.migratePassword)
    .replaceAll("$APP_PW", names.appPassword)
    .replace(/\bcr_migrate\b/g, names.migrate)
    .replace(/\bcr_app\b/g, names.app)
    .replace(/\bcode_reviewer\b/g, names.database)
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

function urlFor(
  base: URL,
  user: string,
  password: string,
  database: string,
): string {
  const url = new URL(base.toString());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function pool(url: string): Pool {
  const connection = new Pool({ connectionString: url, max: 2 });
  connection.on("error", () => undefined);
  return connection;
}

async function run(connection: Pool, sql: string[]): Promise<void> {
  for (const statement of sql) await connection.query(statement);
}

async function setUp(): Promise<{
  names: Names;
  base: URL;
  migrateUrl: string;
  appUrl: string;
  admin: Pool;
  inDatabase: Pool;
  sql: ReturnType<typeof guideSql>;
}> {
  const configured = postgresTestUrl();
  if (!configured) throw new Error("TEST_DATABASE_URL is not set.");
  const base = new URL(configured);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const names: Names = {
    migrate: `cr_migrate_${suffix}`,
    app: `cr_app_${suffix}`,
    database: `code_reviewer_${suffix}`,
    migratePassword: randomBytes(32).toString("hex"),
    appPassword: randomBytes(32).toString("hex"),
  };
  const sql = guideSql();
  const admin = pool(configured);
  const inDatabase = pool(
    urlFor(
      base,
      decodeURIComponent(base.username),
      decodeURIComponent(base.password),
      names.database,
    ),
  );
  cleanUpAfterTest(async () => {
    await inDatabase.end().catch(() => undefined);
    const closer = pool(configured);
    await closer.query(
      `drop database if exists "${names.database}" with (force)`,
    );
    await closer.query(`drop role if exists "${names.app}"`);
    await closer.query(`drop role if exists "${names.migrate}"`);
    await closer.end();
    await admin.end().catch(() => undefined);
  });
  // The guide's first block: the roles and the database, as the administrator.
  await run(admin, statements(sql.roles, names));
  return {
    names,
    base,
    migrateUrl: urlFor(
      base,
      names.migrate,
      names.migratePassword,
      names.database,
    ),
    appUrl: urlFor(base, names.app, names.appPassword, names.database),
    admin,
    inDatabase,
    sql,
  };
}

async function migrateAs(url: string): Promise<void> {
  const lines: string[] = [];
  const exit = await runMigrateCommand(
    { DATABASE_URL_MIGRATE: url },
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  expect(lines.join("\n")).not.toContain(url);
  expect(exit, lines.join("\n")).toBe(0);
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describePostgres("the migrate role and the app role of the guide", () => {
  // #333-T05
  it("lets the migrate role migrate and the app role read and write, but not change the schema", async () => {
    const setup = await setUp();
    // Block 2, as the administrator in the new database; block 3, as the migrate role.
    await run(setup.inDatabase, statements(setup.sql.schema, setup.names));
    const asMigrate = pool(setup.migrateUrl);
    cleanUpAfterTest(() => asMigrate.end());
    await run(asMigrate, statements(setup.sql.defaults, setup.names));

    await migrateAs(setup.migrateUrl);

    const db = openPostgresDatabase({
      driver: "postgres",
      url: setup.appUrl,
      poolMax: 2,
    });
    cleanUpAfterTest(() => db.destroy());
    // The health check of the serverless App reads the migration table and app_meta.
    expect(await checkHealth(() => db, { checkSchema: true })).toEqual({
      status: "ok",
    });
    const asApp = pool(setup.appUrl);
    cleanUpAfterTest(() => asApp.end());
    await asApp.query(
      "insert into app_meta (key, value, updated_at) values ('role-split', 'x', 'now')",
    );
    await asApp.query(
      "update app_meta set value = 'y' where key = 'role-split'",
    );
    expect(
      (await asApp.query("select value from app_meta where key = 'role-split'"))
        .rows,
    ).toEqual([{ value: "y" }]);
    await asApp.query("delete from app_meta where key = 'role-split'");
    // No DDL for the app role: permission denied (42501), never a changed schema.
    await expect(
      asApp.query("create table not_allowed (id text)"),
    ).rejects.toSatisfy((error) => code(error) === "42501");
    await expect(
      asApp.query("alter table app_meta add column extra text"),
    ).rejects.toSatisfy((error) => ["42501"].includes(code(error) ?? ""));
    await expect(asApp.query("drop table app_meta")).rejects.toSatisfy(
      (error) => ["42501"].includes(code(error) ?? ""),
    );
  });

  // #333-T05
  it("repairs the tables that existed before the default privileges with the guide's grant", async () => {
    const setup = await setUp();
    await run(setup.inDatabase, statements(setup.sql.schema, setup.names));
    // Migrated before block 3: the tables exist, and the app role has no privilege on them.
    await migrateAs(setup.migrateUrl);
    const asApp = pool(setup.appUrl);
    cleanUpAfterTest(() => asApp.end());
    await expect(
      asApp.query("select 1 from app_meta limit 1"),
    ).rejects.toSatisfy((error) => code(error) === "42501");

    const asMigrate = pool(setup.migrateUrl);
    cleanUpAfterTest(() => asMigrate.end());
    await run(asMigrate, statements(setup.sql.repair, setup.names));

    await asApp.query("select 1 from app_meta limit 1");
    await asApp.query(
      "insert into app_meta (key, value, updated_at) values ('repaired', 'x', 'now')",
    );
  });
});
