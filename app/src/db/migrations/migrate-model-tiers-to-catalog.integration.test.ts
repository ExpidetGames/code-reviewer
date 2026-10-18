// SPDX-License-Identifier: Apache-2.0

// #434: the migration that turns the old managed model tiers into catalog entries, on SQLite and on Postgres. Every case
// builds the database the previous release left (all migrations before this one), writes the old data into it as that
// release wrote it, and runs the real migration runner. The data is never decrypted (nothing in it is secret) and the
// old data stays where it is.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it, vi } from "vitest";
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
import { entryIdOf } from "./model-tiers-to-catalog.ts";

const KEY = "20261018170000_migrate_model_tiers_to_catalog";
const T = "2026-10-18T08:00:00.000Z";

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < KEY,
      ),
    );
  },
};

type Engine = {
  name: "sqlite" | "postgres";
  /** An empty database migrated to the state before this migration. */
  open: () => Promise<Kysely<Database>>;
};

const sqlite: Engine = {
  name: "sqlite",
  open: async () => {
    const directory = await createTestDirectory();
    const db = track(
      openDatabase({
        driver: "sqlite",
        path: `${directory}/app.db`,
        busyTimeoutMs: 5000,
      }),
    );
    await migrateToLatest(db, beforeThisMigration);
    return db;
  },
};

const postgres: Engine = {
  name: "postgres",
  open: async () => {
    const database = await createPostgresTestDatabase({ migrate: false });
    await migrateToLatest(database.db, beforeThisMigration);
    return database.db;
  },
};

const engines: Engine[] = hasPostgres() ? [sqlite, postgres] : [sqlite];

type Fixture = {
  /** The stored `managed_model_tiers` (a value to encode, or raw text), or none. */
  tiers?: unknown;
  rawTiers?: string;
  workspaces?: Array<{
    id: string;
    /** The stored workspace review defaults (a value or raw text). */
    defaults?: unknown;
    rawDefaults?: string;
    keyMode?: "own" | "managed";
    projects?: Array<{
      id: string;
      settings?: unknown;
      rawSettings?: string;
    }>;
  }>;
};

async function seed(db: Kysely<Database>, fixture: Fixture): Promise<void> {
  if (fixture.tiers !== undefined || fixture.rawTiers !== undefined)
    await db
      .insertInto("instance_settings")
      .values({
        key: "managed_model_tiers",
        value: fixture.rawTiers ?? JSON.stringify(fixture.tiers),
        updated_by: null,
        updated_at: T,
      })
      .execute();
  for (const workspace of fixture.workspaces ?? []) {
    await db
      .insertInto("workspaces")
      .values({
        id: workspace.id,
        name: workspace.id,
        slug: workspace.id,
        created_by: null,
        created_at: T,
      })
      .execute();
    if (workspace.keyMode !== undefined)
      await sql`insert into workspace_entitlements
        (workspace_id, plan_label, key_mode, limits, period_start, suspended, suspension_code, updated_by, updated_at)
        values (${workspace.id}, 'plan', ${workspace.keyMode}, '{}', ${T}, 0, null, null, ${T})`.execute(
        db,
      );
    if (workspace.defaults !== undefined || workspace.rawDefaults !== undefined)
      await db
        .insertInto("app_settings")
        .values({
          workspace_id: workspace.id,
          key: "review_defaults",
          value: workspace.rawDefaults ?? JSON.stringify(workspace.defaults),
          updated_by: null,
          updated_at: T,
        })
        .execute();
    if ((workspace.projects ?? []).length === 0) continue;
    await db
      .insertInto("integrations")
      .values({
        id: `i-${workspace.id}`,
        workspace_id: workspace.id,
        type: "github_app",
        display_name: "acme",
        external_id: `inst-${workspace.id}`,
        config: "{}",
        credentials: null,
        webhook_secret: null,
        status: "active",
        created_at: T,
        updated_at: T,
      })
      .execute();
    for (const project of workspace.projects ?? []) {
      await db
        .insertInto("repositories")
        .values({
          id: `r-${project.id}`,
          workspace_id: workspace.id,
          integration_id: `i-${workspace.id}`,
          external_id: `ext-${project.id}`,
          full_name: `acme/${project.id}`,
          url: `https://github.test/acme/${project.id}`,
          active: 1,
          created_at: T,
          updated_at: T,
        })
        .execute();
      await db
        .insertInto("projects")
        .values({
          id: project.id,
          repository_id: `r-${project.id}`,
          active: 1,
          settings:
            project.rawSettings ?? JSON.stringify(project.settings ?? {}),
          created_at: T,
          updated_at: T,
        })
        .execute();
    }
  }
}

async function snapshot(db: Kysely<Database>) {
  return {
    entries: await db
      .selectFrom("model_catalog_entries")
      .selectAll()
      .orderBy("sort_order")
      .orderBy("name")
      .execute(),
    settings: await db
      .selectFrom("instance_settings")
      .selectAll()
      .orderBy("key")
      .execute(),
    projects: await db
      .selectFrom("projects")
      .select(["id", "settings"])
      .orderBy("id")
      .execute(),
    appSettings: await db
      .selectFrom("app_settings")
      .select(["workspace_id", "key", "value"])
      .orderBy("workspace_id")
      .execute(),
  };
}

async function projectSettings(db: Kysely<Database>, id: string) {
  const row = await db
    .selectFrom("projects")
    .select("settings")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.settings) as Record<string, unknown>;
}

/** Many projects of one workspace with a high tier, written in bulk: a third own a low tier, a third inherit, a third chose. */
async function seedMany(db: Kysely<Database>, count: number): Promise<void> {
  await seed(db, {
    tiers: DIFFERENT,
    workspaces: [{ id: "w-big", defaults: { modelTier: "high" } }],
  });
  await db
    .insertInto("integrations")
    .values({
      id: "i-w-big",
      workspace_id: "w-big",
      type: "github_app",
      display_name: "acme",
      external_id: "inst-w-big",
      config: "{}",
      credentials: null,
      webhook_secret: null,
      status: "active",
      created_at: T,
      updated_at: T,
    })
    .execute();
  const settingsOf = (index: number): string =>
    index % 3 === 0
      ? JSON.stringify({ modelTier: "low", maxFindings: 3 })
      : index % 3 === 1
        ? "{}"
        : JSON.stringify({
            catalogEntryDiff: "mce_chosen",
            catalogEntryDynamic: "mce_chosen",
          });
  for (let from = 0; from < count; from += 300) {
    const indexes = Array.from(
      { length: Math.min(300, count - from) },
      (_, offset) => from + offset,
    );
    await db
      .insertInto("repositories")
      .values(
        indexes.map((index) => ({
          id: `r-${index}`,
          workspace_id: "w-big",
          integration_id: "i-w-big",
          external_id: `ext-${index}`,
          full_name: `acme/${index}`,
          url: `https://github.test/acme/${index}`,
          active: 1,
          created_at: T,
          updated_at: T,
        })),
      )
      .execute();
    await db
      .insertInto("projects")
      .values(
        indexes.map((index) => ({
          id: `p-${index}`,
          repository_id: `r-${index}`,
          active: 1,
          settings: settingsOf(index),
          created_at: T,
          updated_at: T,
        })),
      )
      .execute();
  }
}

/** The number of statements a function sends to the database. */
async function statementsOf(
  db: Kysely<Database>,
  run: (counted: Kysely<Database>) => Promise<void>,
): Promise<number> {
  let statements = 0;
  await run(
    db.withPlugin({
      transformQuery(args) {
        statements += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    }),
  );
  return statements;
}

async function defaults(db: Kysely<Database>) {
  const row = await db
    .selectFrom("instance_settings")
    .select("value")
    .where("key", "=", "catalog_defaults")
    .executeTakeFirst();
  return row === undefined ? undefined : (JSON.parse(row.value) as unknown);
}

async function migrate(db: Kysely<Database>): Promise<void> {
  await migrateToLatest(db, migrationProvider);
}

const EQUAL = {
  low: { diff: "acme/low-1", dynamic: "acme/low-1" },
  medium: { diff: "acme/mid-1", dynamic: "acme/mid-1" },
  high: { diff: "acme/high-1", dynamic: "acme/high-1" },
};
const DIFFERENT = {
  low: { diff: "acme/low-d", dynamic: "acme/low-y" },
  medium: { diff: "acme/mid-d", dynamic: "acme/mid-y" },
  high: { diff: "acme/high-d", dynamic: "acme/high-y" },
};

/**
 * The migrations of the previous release plus this one, where every read of the projects' settings is followed by a
 * save of p-1 by someone else (the first `saves` reads, or every read) before the migration writes. The hook runs on
 * the connection of the runner's transaction, so a failure rolls the whole batch back like in production.
 */
function withConcurrentSaves(saves: number): MigrationProvider {
  let reads = 0;
  return {
    async getMigrations() {
      const { migration } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      return {
        ...(await beforeThisMigration.getMigrations()),
        [KEY]: {
          async up(db) {
            await migration.up(
              db.withPlugin({
                transformQuery: (args) => args.node,
                async transformResult(args) {
                  const row = args.result.rows[0] as
                    Record<string, unknown> | undefined;
                  if (row?.id !== "p-1" || !("settings" in row))
                    return args.result;
                  reads += 1;
                  if (reads <= saves)
                    await db
                      .updateTable("projects")
                      .set({
                        settings: JSON.stringify({
                          modelTier: "low",
                          maxFindings: 8 + reads,
                        }),
                      })
                      .where("id", "=", "p-1")
                      .execute();
                  return args.result;
                },
              }),
            );
          },
        },
      };
    },
  };
}

async function seedConcurrent(db: Kysely<Database>): Promise<void> {
  await seed(db, {
    tiers: DIFFERENT,
    workspaces: [
      {
        id: "w-1",
        projects: [
          { id: "p-1", settings: { modelTier: "low", maxFindings: 1 } },
          { id: "p-2", settings: { modelTier: "high" } },
        ],
      },
    ],
  });
}

for (const engine of engines) {
  describe(`the tier migration on ${engine.name}`, () => {
    // #434-T01, #434-T06, #434-T07
    it("changes nothing on an empty database and on an instance that never configured tiers", async () => {
      const db = await engine.open();
      await seed(db, {
        workspaces: [
          {
            id: "w-1",
            keyMode: "own",
            defaults: { maxFindings: 3 },
            projects: [{ id: "p-1", settings: { maxFindings: 4 } }],
          },
        ],
      });
      const before = await snapshot(db);
      await migrate(db);
      expect(await snapshot(db)).toEqual(before);
      expect(await defaults(db)).toBeUndefined();
    });

    // #434-T01, #434-T07
    it("makes one released entry per tier when Diff and Dynamic share a model, and the medium ones the defaults", async () => {
      const db = await engine.open();
      await seed(db, { tiers: EQUAL });
      await migrate(db);

      const entries = await db
        .selectFrom("model_catalog_entries")
        .selectAll()
        .orderBy("sort_order")
        .execute();
      expect(
        entries.map((entry) => ({
          name: entry.name,
          name_key: entry.name_key,
          provider: entry.provider,
          model_id: entry.model_id,
          serves_diff: entry.serves_diff,
          serves_dynamic: entry.serves_dynamic,
          status: entry.status,
          updated_by: entry.updated_by,
        })),
      ).toEqual([
        {
          name: "Low",
          name_key: "low",
          provider: "openrouter",
          model_id: "acme/low-1",
          serves_diff: 1,
          serves_dynamic: 1,
          status: "released",
          updated_by: null,
        },
        {
          name: "Medium",
          name_key: "medium",
          provider: "openrouter",
          model_id: "acme/mid-1",
          serves_diff: 1,
          serves_dynamic: 1,
          status: "released",
          updated_by: null,
        },
        {
          name: "High",
          name_key: "high",
          provider: "openrouter",
          model_id: "acme/high-1",
          serves_diff: 1,
          serves_dynamic: 1,
          status: "released",
          updated_by: null,
        },
      ]);
      expect(entries.map((entry) => entry.sort_order)).toEqual([0, 1, 2]);
      for (const entry of entries) {
        expect(entry.description).toMatch(/^\S.{10,158}\.$/);
        expect(entry.description).not.toContain("acme");
        expect(entry.created_at).toBe(entry.updated_at);
      }
      expect(await defaults(db)).toEqual({
        diff: entryIdOf("medium"),
        dynamic: entryIdOf("medium"),
      });
    });

    // #434-T01, #434-T07
    it("makes two entries per tier when the models differ, named by kind", async () => {
      const db = await engine.open();
      await seed(db, { tiers: DIFFERENT });
      await migrate(db);
      const entries = await db
        .selectFrom("model_catalog_entries")
        .select(["name", "model_id", "serves_diff", "serves_dynamic"])
        .orderBy("sort_order")
        .execute();
      expect(entries.map((entry) => entry.name)).toEqual([
        "Low (Diff)",
        "Low (Dynamic)",
        "Medium (Diff)",
        "Medium (Dynamic)",
        "High (Diff)",
        "High (Dynamic)",
      ]);
      expect(entries[1]).toEqual({
        name: "Low (Dynamic)",
        model_id: "acme/low-y",
        serves_diff: 0,
        serves_dynamic: 1,
      });
      expect(await defaults(db)).toEqual({
        diff: entryIdOf("medium-diff"),
        dynamic: entryIdOf("medium-dynamic"),
      });
    });

    // #434-T01, #434-T07
    it("copes with a tier that has no model for a kind and with a partial configuration", async () => {
      const db = await engine.open();
      await seed(db, {
        tiers: {
          low: { diff: "acme/low-d" },
          high: { dynamic: "acme/high-y", diff: "not a model id" },
        },
        workspaces: [
          {
            id: "w-1",
            projects: [
              { id: "p-low", settings: { modelTier: "low" } },
              { id: "p-high", settings: { modelTier: "high" } },
              { id: "p-medium", settings: { modelTier: "medium" } },
            ],
          },
        ],
      });
      await migrate(db);
      expect(
        (
          await db
            .selectFrom("model_catalog_entries")
            .select("name")
            .orderBy("sort_order")
            .execute()
        ).map((entry) => entry.name),
      ).toEqual(["Low (Diff)", "High (Dynamic)"]);
      // The medium tier had no model at all: no default is written, and a project that chose it gets no entry.
      expect(await defaults(db)).toBeUndefined();
      expect(await projectSettings(db, "p-low")).toEqual({
        modelTier: "low",
        catalogEntryDiff: entryIdOf("low-diff"),
      });
      expect(await projectSettings(db, "p-high")).toEqual({
        modelTier: "high",
        catalogEntryDynamic: entryIdOf("high-dynamic"),
      });
      expect(await projectSettings(db, "p-medium")).toEqual({
        modelTier: "medium",
      });
    });

    // #434-T01, #434-T12, #434-T07
    it("maps the tier of every project and of the workspace to the entries, and keeps the default tier unwritten", async () => {
      const db = await engine.open();
      await seed(db, {
        tiers: DIFFERENT,
        workspaces: [
          {
            id: "w-managed",
            keyMode: "managed",
            defaults: { modelTier: "high", maxFindings: 7 },
            projects: [
              { id: "p-inherits", settings: { maxFindings: 2 } },
              { id: "p-own-low", settings: { modelTier: "low" } },
              { id: "p-own-medium", settings: { modelTier: "medium" } },
              { id: "p-chosen", settings: { catalogEntryDiff: "mce_chosen" } },
            ],
          },
          {
            id: "w-default",
            keyMode: "managed",
            defaults: { modelTier: "medium" },
            projects: [
              { id: "q-inherits", settings: {} },
              { id: "q-high", settings: { modelTier: "high" } },
            ],
          },
        ],
      });
      await migrate(db);

      const high = {
        catalogEntryDiff: entryIdOf("high-diff"),
        catalogEntryDynamic: entryIdOf("high-dynamic"),
      };
      expect(await projectSettings(db, "p-inherits")).toEqual({
        maxFindings: 2,
        ...high,
      });
      expect(await projectSettings(db, "p-own-low")).toEqual({
        modelTier: "low",
        catalogEntryDiff: entryIdOf("low-diff"),
        catalogEntryDynamic: entryIdOf("low-dynamic"),
      });
      // An explicit tier wins over the workspace's, and the default tier is pinned when it was chosen explicitly.
      expect(await projectSettings(db, "p-own-medium")).toEqual({
        modelTier: "medium",
        catalogEntryDiff: entryIdOf("medium-diff"),
        catalogEntryDynamic: entryIdOf("medium-dynamic"),
      });
      // A selection made in the catalog chooser is never replaced; the kind it left open follows the workspace's tier.
      expect(await projectSettings(db, "p-chosen")).toEqual({
        catalogEntryDiff: "mce_chosen",
        catalogEntryDynamic: high.catalogEntryDynamic,
      });
      expect(await projectSettings(db, "q-inherits")).toEqual({});
      expect(await projectSettings(db, "q-high")).toEqual({
        modelTier: "high",
        ...high,
      });
    });

    // #434-T06
    it("rewrites the settings of a project of a workspace on its own key too, and nothing reads them while the key is its own", async () => {
      const db = await engine.open();
      await seed(db, {
        tiers: DIFFERENT,
        workspaces: [
          {
            id: "w-own",
            keyMode: "own",
            defaults: { modelTier: "high" },
            projects: [
              { id: "o-1", settings: { modelTier: "low" } },
              { id: "o-2", settings: { maxFindings: 2 } },
            ],
          },
        ],
      });
      await migrate(db);

      // The data of such a project does change (the workspace may turn managed later, and then the entry applies). What a
      // workspace on its own key runs does not: its claim never looks at an entry (`model-tiers-migration-claim`, T06).
      expect(await projectSettings(db, "o-1")).toEqual({
        modelTier: "low",
        catalogEntryDiff: entryIdOf("low-diff"),
        catalogEntryDynamic: entryIdOf("low-dynamic"),
      });
      expect(await projectSettings(db, "o-2")).toEqual({
        maxFindings: 2,
        catalogEntryDiff: entryIdOf("high-diff"),
        catalogEntryDynamic: entryIdOf("high-dynamic"),
      });
    });

    // #434-T03, #434-T07
    it("leaves the old tier data in place: the setting, the workspace defaults and every modelTier", async () => {
      const db = await engine.open();
      await seed(db, {
        tiers: EQUAL,
        workspaces: [
          {
            id: "w-1",
            defaults: { modelTier: "high" },
            projects: [{ id: "p-1", settings: { modelTier: "low" } }],
          },
        ],
      });
      const before = await snapshot(db);
      await migrate(db);
      const after = await snapshot(db);
      expect(
        after.settings.find((row) => row.key === "managed_model_tiers"),
      ).toEqual(
        before.settings.find((row) => row.key === "managed_model_tiers"),
      );
      expect(after.appSettings).toEqual(before.appSettings);
      expect((await projectSettings(db, "p-1")).modelTier).toBe("low");
    });

    // #434-T02, #434-T07
    it("is a no-op when its body runs a second time", async () => {
      const db = await engine.open();
      await seed(db, {
        tiers: DIFFERENT,
        workspaces: [
          {
            id: "w-1",
            defaults: { modelTier: "low" },
            projects: [
              { id: "p-1", settings: {} },
              { id: "p-2", settings: { modelTier: "high" } },
            ],
          },
        ],
      });
      await migrate(db);
      const first = await snapshot(db);
      const { migration } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      await migration.up(db);
      expect(await snapshot(db)).toEqual(first);
    });

    // #434-T02
    it("keeps what the operator did since: a changed model, a retired entry, a chosen default", async () => {
      const db = await engine.open();
      await seed(db, { tiers: EQUAL });
      await migrate(db);
      await db
        .updateTable("model_catalog_entries")
        .set({ model_id: "acme/changed", status: "retired" })
        .where("id", "=", entryIdOf("high"))
        .execute();
      await db
        .updateTable("instance_settings")
        .set({
          value: JSON.stringify({ diff: entryIdOf("low"), dynamic: null }),
        })
        .where("key", "=", "catalog_defaults")
        .execute();
      const { migration } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      await migration.up(db);
      const high = await db
        .selectFrom("model_catalog_entries")
        .select(["model_id", "status"])
        .where("id", "=", entryIdOf("high"))
        .executeTakeFirstOrThrow();
      expect(high).toEqual({ model_id: "acme/changed", status: "retired" });
      expect(await defaults(db)).toEqual({
        diff: entryIdOf("low"),
        dynamic: entryIdOf("medium"),
      });
    });

    // #434-T05
    it("skips damaged settings, names them by id in the log, and still succeeds", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const db = await engine.open();
      await seed(db, {
        tiers: EQUAL,
        workspaces: [
          {
            id: "w-bad",
            rawDefaults: "{not json",
            projects: [
              { id: "p-bad", rawSettings: "{{{ secret-looking-text" },
              { id: "p-array", rawSettings: "[1,2]" },
              { id: "p-fine", settings: { modelTier: "high" } },
            ],
          },
        ],
      });
      await migrate(db);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("p-bad"))).toBe(true);
      expect(lines.some((line) => line.includes("p-array"))).toBe(true);
      expect(lines.some((line) => line.includes("w-bad"))).toBe(true);
      expect(lines.join("\n")).not.toContain("secret-looking-text");
      const row = await db
        .selectFrom("projects")
        .select("settings")
        .where("id", "=", "p-bad")
        .executeTakeFirstOrThrow();
      expect(row.settings).toBe("{{{ secret-looking-text");
      expect(await projectSettings(db, "p-fine")).toEqual({
        modelTier: "high",
        catalogEntryDiff: entryIdOf("high"),
        catalogEntryDynamic: entryIdOf("high"),
      });
    });

    // #434-T05
    it("treats a damaged tier configuration as none and still succeeds", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      void warn;
      const db = await engine.open();
      await seed(db, {
        rawTiers: "this is not json",
        workspaces: [
          {
            id: "w-1",
            projects: [{ id: "p-1", settings: { modelTier: "high" } }],
          },
        ],
      });
      await migrate(db);
      expect(
        await db.selectFrom("model_catalog_entries").selectAll().execute(),
      ).toEqual([]);
      expect(await projectSettings(db, "p-1")).toEqual({ modelTier: "high" });
    });

    // #434-T01
    it("gives an entry a different name when the operator already has one with the name", async () => {
      const db = await engine.open();
      await seed(db, { tiers: EQUAL });
      await db
        .insertInto("model_catalog_entries")
        .values({
          id: "mce_operators",
          name: "MEDIUM",
          name_key: "medium",
          description: null,
          provider: "openrouter",
          model_id: "acme/other",
          serves_diff: 1,
          serves_dynamic: 0,
          status: "draft",
          sort_order: 5,
          created_at: T,
          updated_at: T,
          updated_by: null,
        })
        .execute();
      await migrate(db);
      const names = (
        await db
          .selectFrom("model_catalog_entries")
          .select(["name", "sort_order"])
          .orderBy("sort_order")
          .execute()
      ).map((entry) => entry.name);
      expect(names).toEqual(["MEDIUM", "Low", "Medium (migrated)", "High"]);
    });

    // #434-X4
    it("rewrites the projects with a number of statements that does not grow with their number", async () => {
      const { migration } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      const few = await engine.open();
      await seedMany(few, 9);
      const forFew = await statementsOf(few, (counted) =>
        migration.up(counted),
      );
      const many = await engine.open();
      await seedMany(many, 1_200);
      const forMany = await statementsOf(many, (counted) =>
        migration.up(counted),
      );

      // 1,200 projects are written in chunks (three at most), never one statement each.
      expect(forMany).toBeLessThanOrEqual(forFew + 2);

      const low = {
        modelTier: "low",
        maxFindings: 3,
        catalogEntryDiff: entryIdOf("low-diff"),
        catalogEntryDynamic: entryIdOf("low-dynamic"),
      };
      const high = {
        catalogEntryDiff: entryIdOf("high-diff"),
        catalogEntryDynamic: entryIdOf("high-dynamic"),
      };
      const chosen = {
        catalogEntryDiff: "mce_chosen",
        catalogEntryDynamic: "mce_chosen",
      };
      for (const index of [0, 3, 600, 1_197])
        expect(await projectSettings(many, `p-${index}`)).toEqual(low);
      for (const index of [1, 4, 700, 1_198])
        expect(await projectSettings(many, `p-${index}`)).toEqual(high);
      for (const index of [2, 5, 800, 1_199])
        expect(await projectSettings(many, `p-${index}`)).toEqual(chosen);

      // A second run finds everything written and sends no write.
      const again = await snapshot(many);
      await migration.up(many);
      expect(await snapshot(many)).toEqual(again);
    });

    // #434-X4
    it("never overwrites a settings text that changed after it was read", async () => {
      const db = await engine.open();
      await seed(db, {
        workspaces: [
          {
            id: "w-1",
            projects: [
              { id: "p-1", settings: { maxFindings: 1 } },
              { id: "p-2", settings: { maxFindings: 2 } },
            ],
          },
        ],
      });
      const { writeIfUnchanged } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      // p-1 was saved by someone else since it was read; p-2 is as it was read.
      await db
        .updateTable("projects")
        .set({ settings: JSON.stringify({ maxFindings: 9 }) })
        .where("id", "=", "p-1")
        .execute();

      const written = await writeIfUnchanged(db, [
        {
          id: "p-1",
          read: JSON.stringify({ maxFindings: 1 }),
          text: JSON.stringify({ maxFindings: 1, catalogEntryDiff: "x" }),
        },
        {
          id: "p-2",
          read: JSON.stringify({ maxFindings: 2 }),
          text: JSON.stringify({ maxFindings: 2, catalogEntryDiff: "x" }),
        },
      ]);

      expect([...written]).toEqual(["p-2"]);
      expect(await projectSettings(db, "p-1")).toEqual({ maxFindings: 9 });
      expect(await projectSettings(db, "p-2")).toEqual({
        maxFindings: 2,
        catalogEntryDiff: "x",
      });
    });

    // #434-N-B
    it("keeps a settings save that landed between the read and the write, and adds the entries on the retry", async () => {
      const db = await engine.open();
      await seedConcurrent(db);

      // p-1 is saved once by someone else after the first read (it changes maxFindings and still has its tier).
      await migrateToLatest(db, withConcurrentSaves(1));

      const entries = {
        catalogEntryDiff: entryIdOf("low-diff"),
        catalogEntryDynamic: entryIdOf("low-dynamic"),
      };
      expect(await projectSettings(db, "p-1")).toEqual({
        modelTier: "low",
        maxFindings: 9,
        ...entries,
      });
      expect(await projectSettings(db, "p-2")).toEqual({
        modelTier: "high",
        catalogEntryDiff: entryIdOf("high-diff"),
        catalogEntryDynamic: entryIdOf("high-dynamic"),
      });
    });

    // #434-N-A
    it("fails loudly and rolls everything back when a project keeps changing, so a rerun is safe", async () => {
      const db = await engine.open();
      await seedConcurrent(db);
      const before = await snapshot(db);

      // Every read of p-1 is followed by another save: the three attempts run out.
      const failure = await migrateToLatest(
        db,
        withConcurrentSaves(Number.POSITIVE_INFINITY),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("1 project");
      expect(message).toContain("p-1");
      expect(message).not.toContain("p-2");
      expect(message).toContain("Run the deploy again");
      // Nothing of the batch is applied or recorded: no entry, no default, no project rewritten, and not marked as run.
      // (The saves of the hook were made on the same connection, so they are rolled back too.)
      expect(await snapshot(db)).toEqual(before);
      expect(await defaults(db)).toBeUndefined();
      const recorded = await sql<{ name: string }>`
        select name from kysely_migration where name = ${KEY}
      `.execute(db);
      expect(recorded.rows).toEqual([]);

      // The rerun finds the quiet database, migrates every project and records the migration.
      await migrate(db);
      expect((await projectSettings(db, "p-1")).catalogEntryDiff).toBe(
        entryIdOf("low-diff"),
      );
      expect((await projectSettings(db, "p-2")).catalogEntryDiff).toBe(
        entryIdOf("high-diff"),
      );
    });
  });
}
