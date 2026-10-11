// The migration that introduces workspaces (migrations 20261011160000 to 20261011160200): an
// installation that holds data keeps every row and gets one default workspace, an empty one gets
// none, nobody becomes a member by migration, and a failure leaves the file as it was.
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { createTestDirectory, track } from "../test-support/test-database.ts";
import { openDatabase } from "./connection.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";

const FIRST_WORKSPACE_MIGRATION = "20261011160000_create_workspaces";

/** The migrations of the version before workspaces existed. */
const previousVersion: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < FIRST_WORKSPACE_MIGRATION,
      ),
    );
  },
};

/** The budget for migrating 10 000 jobs in one transaction; see src/db/README.md. */
const JOB_MIGRATION_BUDGET_MS = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the old schema is not the current Database type.
type OldDb = Kysely<any>;

async function openAtPreviousVersion(): Promise<OldDb> {
  const directory = await createTestDirectory();
  const db: OldDb = track(
    openDatabase({ path: join(directory, "app.db"), busyTimeoutMs: 5000 }),
  );
  await migrateToLatest(db, previousVersion);
  return db;
}

const T = "2026-10-01T10:00:00.000Z";
const RESULT_2KB = JSON.stringify({ ok: true, logTail: "x".repeat(2000) });

async function seedInstallation(db: OldDb): Promise<void> {
  for (const [id, login] of [
    ["u1", "alice"],
    ["u2", "bob"],
    ["u3", "carol"],
  ] as const)
    await db
      .insertInto("users")
      .values({
        id,
        name: login,
        email: `${login}@example.test`,
        email_verified: 1,
        github_login: login,
        created_at: T,
        updated_at: T,
      })
      .execute();
  await db
    .insertInto("sessions")
    .values({
      id: "s1",
      expires_at: "2027-01-01T00:00:00.000Z",
      token: "token-1",
      created_at: T,
      updated_at: T,
      user_id: "u1",
    })
    .execute();
  for (const [id, externalId] of [
    ["i1", "1001"],
    ["i2", "1002"],
  ] as const)
    await db
      .insertInto("integrations")
      .values({
        id,
        type: "github_app",
        display_name: `acme-${externalId}`,
        external_id: externalId,
        config: "{}",
        status: "active",
        created_at: T,
        updated_at: T,
      })
      .execute();
  for (const [id, integrationId, externalId] of [
    ["r1", "i1", "11"],
    ["r2", "i1", "12"],
    ["r3", "i2", "21"],
  ] as const)
    await db
      .insertInto("repositories")
      .values({
        id,
        integration_id: integrationId,
        external_id: externalId,
        full_name: `acme/${id}`,
        url: `https://github.test/acme/${id}`,
        active: 1,
        created_at: T,
        updated_at: T,
      })
      .execute();
  await db
    .insertInto("projects")
    .values({
      id: "p1",
      repository_id: "r1",
      active: 1,
      settings: '{"a":1}',
      created_at: T,
      updated_at: T,
    })
    .execute();
  for (const [id, supersededBy] of [
    ["j2", null],
    ["j1", "j2"],
    ["j3", null],
  ] as const)
    await db
      .insertInto("jobs")
      .values(oldJob(id, "r1", id === "j3" ? 8 : 7, supersededBy))
      .execute();
  await db
    .insertInto("job_comments")
    .values({ repository_id: "r1", comment_id: "c1", job_id: "j3" })
    .execute();
  await db
    .insertInto("app_settings")
    .values({
      key: "review_defaults",
      value: '{"x":true}',
      updated_at: T,
      updated_by: "alice",
    })
    .execute();
}

function oldJob(
  id: string,
  repositoryId: string,
  prNumber: number,
  supersededBy: string | null = null,
) {
  // A finished job holds the result of its review, about 2 KB; the size is what makes a migration of
  // many jobs slow when something in it is not indexed.
  return {
    id,
    repository_id: repositoryId,
    pr_number: prNumber,
    pr_url: `https://github.test/acme/${repositoryId}/pull/${String(prNumber)}`,
    head_sha: "a".repeat(40),
    command: "review",
    args: "",
    trigger_kind: "manual",
    actor_login: "alice",
    status: "succeeded",
    run_after: T,
    attempts: 0,
    result: RESULT_2KB,
    superseded_by: supersededBy,
    created_at: T,
    updated_at: T,
  };
}

const CUSTOMER_TABLES = [
  "users",
  "sessions",
  "integrations",
  "repositories",
  "projects",
  "jobs",
  "job_comments",
  "app_settings",
] as const;

async function counts(db: OldDb): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of CUSTOMER_TABLES) {
    const { rows } = await sql<{
      count: number;
    }>`select count(*) as count from ${sql.table(table)}`.execute(db);
    result[table] = rows[0]?.count ?? -1;
  }
  return result;
}

async function column(db: OldDb, query: string): Promise<string[]> {
  const { rows } = await sql<{ value: string }>`${sql.raw(query)}`.execute(db);
  return rows.map((row) => row.value);
}

describe("migrating an installation that holds data", () => {
  // DM-01
  it("puts every integration, repository, project, job and the review defaults into one default workspace and keeps every row", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);
    const before = await counts(db);

    await migrateToLatest(db);

    expect(await counts(db)).toEqual(before);
    const workspaces = await db.selectFrom("workspaces").selectAll().execute();
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    expect(workspace).toMatchObject({
      name: "Default workspace",
      slug: "default",
      created_by: null,
    });
    for (const table of [
      "integrations",
      "repositories",
      "jobs",
      "app_settings",
    ] as const) {
      const rows = await db.selectFrom(table).select("workspace_id").execute();
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows)
        expect(row.workspace_id, table).toBe(workspace?.id);
    }
    // Projects belong to the workspace through their repository.
    const { rows: projectRows } = await sql<{ workspace_id: string }>`
      select repositories.workspace_id from projects
      join repositories on repositories.id = projects.repository_id`.execute(
      db,
    );
    expect(projectRows).toEqual([{ workspace_id: workspace?.id }]);
  });

  // DM-01
  it("keeps the content of the rows, the references between them and the sessions of the users", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);

    await migrateToLatest(db);

    expect(
      await db.selectFrom("projects").select(["id", "settings"]).execute(),
    ).toEqual([{ id: "p1", settings: '{"a":1}' }]);
    expect(
      await db
        .selectFrom("jobs")
        .select(["id", "superseded_by"])
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "j1", superseded_by: "j2" },
      { id: "j2", superseded_by: null },
      { id: "j3", superseded_by: null },
    ]);
    expect(await db.selectFrom("job_comments").selectAll().execute()).toEqual([
      { repository_id: "r1", comment_id: "c1", job_id: "j3" },
    ]);
    expect(
      await db
        .selectFrom("app_settings")
        .select(["key", "value", "updated_by"])
        .execute(),
    ).toEqual([
      { key: "review_defaults", value: '{"x":true}', updated_by: "alice" },
    ]);
    expect(await db.selectFrom("sessions").select("id").execute()).toEqual([
      { id: "s1" },
    ]);
    expect(
      await sql`pragma foreign_key_check`.execute(db).then((r) => r.rows),
    ).toEqual([]);
  });

  it("keeps the indexes the tables had and every foreign key resolves to the rebuilt tables", async () => {
    const db = await openAtPreviousVersion();
    const indexesBefore = await column(
      db,
      "select name as value from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name",
    );

    await migrateToLatest(db);

    const indexesAfter = await column(
      db,
      "select name as value from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name",
    );
    for (const name of indexesBefore) expect(indexesAfter).toContain(name);
    expect(indexesAfter).toEqual(
      expect.arrayContaining([
        "integrations_workspace",
        "repositories_workspace",
        "jobs_workspace_recent",
      ]),
    );
    // No foreign key may still point at a table of the rebuild.
    expect(
      await column(
        db,
        "select name as value from sqlite_master where sql like '%_old%' or name like '%_old'",
      ),
    ).toEqual([]);
  });

  // DM-02
  it("creates no workspace member", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);

    await migrateToLatest(db);

    expect(
      await db.selectFrom("workspace_members").selectAll().execute(),
    ).toEqual([]);
  });

  // DM-04
  it("creates no second workspace and no member when the migrated database is started again", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);
    await migrateToLatest(db);

    const second = await migrateToLatest(db);

    expect(second.executed).toEqual([]);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
    expect(
      await db.selectFrom("workspace_members").select("user_id").execute(),
    ).toEqual([]);
  });

  it("creates the default workspace for a database that has users only", async () => {
    const db = await openAtPreviousVersion();
    await db
      .insertInto("users")
      .values({
        id: "u1",
        name: "alice",
        email: "alice@example.test",
        email_verified: 1,
        github_login: "alice",
        created_at: T,
        updated_at: T,
      })
      .execute();

    await migrateToLatest(db);

    expect(await db.selectFrom("workspaces").select("slug").execute()).toEqual([
      { slug: "default" },
    ]);
  });
});

describe("migrating a database without data", () => {
  // DM-03
  it("creates no workspace and no member", async () => {
    const db = await openAtPreviousVersion();

    await migrateToLatest(db);

    expect(await db.selectFrom("workspaces").selectAll().execute()).toEqual([]);
    expect(
      await db.selectFrom("workspace_members").selectAll().execute(),
    ).toEqual([]);
  });
});

describe("users without a GitHub account", () => {
  // DM-05
  it("can be stored without a GitHub login, and an imported user is marked", async () => {
    const db = await openAtPreviousVersion();
    await migrateToLatest(db);

    await db
      .insertInto("users")
      .values({
        id: "u1",
        name: "Pat",
        email: "pat@example.test",
        email_verified: 0,
        created_at: T,
        updated_at: T,
      })
      .execute();

    expect(
      await db
        .selectFrom("users")
        .select(["github_login", "imported_at"])
        .execute(),
    ).toEqual([{ github_login: null, imported_at: null }]);
  });

  it("keeps the GitHub login of existing users", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);

    await migrateToLatest(db);

    expect(
      await db
        .selectFrom("users")
        .select(["id", "github_login", "imported_at"])
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "u1", github_login: "alice", imported_at: null },
      { id: "u2", github_login: "bob", imported_at: null },
      { id: "u3", github_login: "carol", imported_at: null },
    ]);
  });
});

describe("the workspace tables", () => {
  async function migrated() {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);
    await migrateToLatest(db);
    const workspace = await db
      .selectFrom("workspaces")
      .select("id")
      .executeTakeFirstOrThrow();
    return { db, workspaceId: workspace.id };
  }

  // DM-11
  it("refuse a member with an unknown role", async () => {
    const { db, workspaceId } = await migrated();

    await expect(
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: "u1",
          role: "superuser",
          created_at: T,
        })
        .execute(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  // DM-11
  it("accept each of the three roles", async () => {
    const { db, workspaceId } = await migrated();

    for (const [userId, role] of [
      ["u1", "owner"],
      ["u2", "admin"],
      ["u3", "member"],
    ] as const)
      await db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: userId,
          role,
          created_at: T,
        })
        .execute();

    expect(
      await db
        .selectFrom("workspace_members")
        .select("role")
        .orderBy("role")
        .execute(),
    ).toEqual([{ role: "admin" }, { role: "member" }, { role: "owner" }]);
  });

  // DM-11
  it("refuse the same user twice in one workspace", async () => {
    const { db, workspaceId } = await migrated();
    const member = {
      workspace_id: workspaceId,
      user_id: "u1",
      role: "member",
      created_at: T,
    };
    await db.insertInto("workspace_members").values(member).execute();

    await expect(
      db
        .insertInto("workspace_members")
        .values({ ...member, role: "owner" })
        .execute(),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it("refuse a member for a workspace or a user that does not exist", async () => {
    const { db, workspaceId } = await migrated();

    await expect(
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: "nope",
          user_id: "u1",
          role: "member",
          created_at: T,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: "nope",
          role: "member",
          created_at: T,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("refuse a repository that names an integration of another workspace, and a job a repository of another workspace", async () => {
    const { db, workspaceId } = await migrated();
    await db
      .insertInto("workspaces")
      .values({
        id: "w2",
        name: "Two",
        slug: "two",
        created_by: null,
        created_at: T,
      })
      .execute();

    await expect(
      db
        .insertInto("repositories")
        .values({
          id: "rx",
          workspace_id: "w2",
          integration_id: "i1",
          external_id: "99",
          full_name: "acme/rx",
          url: "https://github.test/acme/rx",
          active: 1,
          created_at: T,
          updated_at: T,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db
        .insertInto("jobs")
        .values({ ...oldJob("jx", "r1", 9), workspace_id: "w2" })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db
        .insertInto("jobs")
        .values({ ...oldJob("jy", "r1", 9), workspace_id: workspaceId })
        .execute(),
    ).resolves.toBeDefined();
  });

  it("have the same list of roles as the code", async () => {
    const { WORKSPACE_ROLES } = await import("../workspaces/roles.ts");
    const { db } = await migrated();
    const { rows } = await sql<{ sql: string }>`
      select sql from sqlite_master where name = 'workspace_members'`.execute(
      db,
    );

    for (const role of WORKSPACE_ROLES)
      expect(rows[0]?.sql).toContain(`'${role}'`);
    expect(WORKSPACE_ROLES).toHaveLength(3);
  });
});

describe("migrating a big database", () => {
  // DM-12
  it("moves 10 000 jobs in one transaction within the documented time budget", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);
    await db.transaction().execute(async (trx) => {
      for (let batch = 0; batch < 100; batch += 1) {
        await trx
          .insertInto("jobs")
          .values(
            Array.from({ length: 100 }, (_, index) =>
              oldJob(
                `bulk-${String(batch * 100 + index)}`,
                "r2",
                1000 + batch * 100 + index,
              ),
            ),
          )
          .execute();
      }
    });
    expect((await counts(db)).jobs).toBe(10_003);

    const started = performance.now();
    await migrateToLatest(db);
    const elapsed = performance.now() - started;

    expect((await counts(db)).jobs).toBe(10_003);
    expect(
      await db
        .selectFrom("jobs")
        .select((eb) => eb.fn.count<number>("id").as("count"))
        .where("workspace_id", "is not", null)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 10_003 });
    expect(elapsed).toBeLessThan(JOB_MIGRATION_BUDGET_MS);
  });
});

describe("a failing step of the migration", () => {
  const failing: Migration = {
    async up(db) {
      await sql`this is not valid sql`.execute(db);
    },
  };

  // DM-13
  it("applies nothing of the batch, keeps every row where it was, and ends with MIGRATION_FAILED", async () => {
    const db = await openAtPreviousVersion();
    await seedInstallation(db);
    const before = await counts(db);
    const schemaBefore = await column(
      db,
      "select sql as value from sqlite_master where sql is not null order by name",
    );
    const provider: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          // After the workspace migrations, so they have run inside the same transaction.
          "99999999999999_injected_failure": failing,
        };
      },
    };

    const run = migrateToLatest(db, provider);

    await expect(run).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    await expect(run).rejects.toThrow(/99999999999999_injected_failure/);
    expect(await counts(db)).toEqual(before);
    expect(
      await column(
        db,
        "select sql as value from sqlite_master where sql is not null order by name",
      ),
    ).toEqual(schemaBefore);
    expect(
      await column(
        db,
        "select name as value from sqlite_master where name = 'workspaces'",
      ),
    ).toEqual([]);
    expect(
      await column(
        db,
        "select name as value from kysely_migration order by name",
      ),
    ).not.toContain(FIRST_WORKSPACE_MIGRATION);
  });
});
