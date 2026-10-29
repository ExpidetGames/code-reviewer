// SPDX-License-Identifier: LicenseRef-Proprietary

// #715 (cut 9): a migration is frozen. The tier migration used to import the LLM provider registry and the model catalog;
// it carries what it needs itself now (`./support/`). This test holds the SQL it sends to Postgres, statement by
// statement with its parameters, against a golden file that was recorded from the code before the cut. A change to
// what the migration does, even to one parameter, fails here. To record the file again on purpose (a reviewed change
// of a frozen migration is never expected): `WRITE_MIGRATION_SQL_GOLDEN=1 pnpm exec vitest run --project integration <this file>`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const KEY = "20261018170000_migrate_model_tiers_to_catalog";
const GOLDEN = join(import.meta.dirname, "migration-sql-golden.json");
const T = "2026-10-18T08:00:00.000Z";
const NOW = new Date("2026-10-18T09:30:00.000Z");

type Statement = { sql: string; parameters: readonly unknown[] };

afterEach(() => {
  vi.useRealTimers();
});

/** The migrations of the previous release, then the real migration with every statement it sends recorded. */
function recording(statements: Statement[]): MigrationProvider {
  return {
    async getMigrations() {
      const all = await migrationProvider.getMigrations();
      const before = Object.fromEntries(
        Object.entries(all).filter(([name]) => name < KEY),
      );
      const { migration } =
        await import("./20261018170000_migrate_model_tiers_to_catalog.ts");
      return {
        ...before,
        [KEY]: {
          async up(db) {
            await migration.up(
              db.withPlugin({
                transformQuery(args) {
                  const compiled = db
                    .getExecutor()
                    .compileQuery(args.node, args.queryId);
                  statements.push({
                    sql: compiled.sql,
                    parameters: compiled.parameters,
                  });
                  return args.node;
                },
                async transformResult(args) {
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

async function seed(db: Kysely<Database>): Promise<void> {
  // Tiers: low has one model for both kinds, medium two, high a Diff model and a Dynamic one the old reader refused.
  const tiers = {
    low: { diff: "acme/low-1", dynamic: "acme/low-1" },
    medium: { diff: "acme/mid-d", dynamic: "acme/mid-y" },
    high: { diff: "acme/high-d", dynamic: "not a model id" },
  };
  await db
    .insertInto("instance_settings")
    .values([
      {
        key: "managed_model_tiers",
        value: JSON.stringify(tiers),
        updated_by: null,
        updated_at: T,
      },
      {
        key: "catalog_defaults",
        value: JSON.stringify({ diff: "mce_operator" }),
        updated_by: null,
        updated_at: T,
      },
    ])
    .execute();
  // Entries of the operator: the names "Low" and "Low (migrated)" are taken, so the planned "Low" is renamed twice over.
  await sql`insert into model_catalog_entries
    (id, name, name_key, description, provider, model_id, serves_diff, serves_dynamic, status, sort_order, created_at, updated_at, updated_by)
    values
    ('mce_operator', 'LOW', 'low', 'x', 'openrouter', 'acme/x', 1, 1, 'released', 4, ${T}, ${T}, null),
    ('mce_operator2', 'Low (migrated)', 'low (migrated)', 'x', 'openrouter', 'acme/y', 1, 0, 'released', 7, ${T}, ${T}, null)`.execute(
    db,
  );
  const workspaces = [
    { id: "w-1", defaults: JSON.stringify({ modelTier: "high" }) },
    { id: "w-2", defaults: "not json" },
    { id: "w-3", defaults: JSON.stringify({ modelTier: "medium" }) },
  ];
  const projects = [
    ["p-1", "w-1", JSON.stringify({ modelTier: "low", maxFindings: 3 })],
    ["p-2", "w-1", "{}"],
    ["p-3", "w-2", "this is damaged"],
    ["p-4", "w-3", JSON.stringify({ catalogEntryDiff: "mce_chosen" })],
    ["p-5", "w-3", JSON.stringify({ modelTier: "high" })],
  ] as const;
  for (const workspace of workspaces) {
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
    await db
      .insertInto("app_settings")
      .values({
        workspace_id: workspace.id,
        key: "review_defaults",
        value: workspace.defaults,
        updated_by: null,
        updated_at: T,
      })
      .execute();
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
  }
  for (const [id, workspaceId, settings] of projects) {
    await db
      .insertInto("repositories")
      .values({
        id: `r-${id}`,
        workspace_id: workspaceId,
        integration_id: `i-${workspaceId}`,
        external_id: `ext-${id}`,
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
        id,
        repository_id: `r-${id}`,
        active: 1,
        settings,
        created_at: T,
        updated_at: T,
      })
      .execute();
  }
}

describe("the SQL of a frozen migration", () => {
  // #715-T05
  it("is the SQL it sent before it stopped importing application code, with the same parameters", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, {
      async getMigrations() {
        return Object.fromEntries(
          Object.entries(await migrationProvider.getMigrations()).filter(
            ([name]) => name < KEY,
          ),
        );
      },
    });
    await seed(db);
    const statements: Statement[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const outcome = await migrateToLatest(db, recording(statements));
    vi.useRealTimers();
    expect(outcome.executed).toEqual([KEY]);

    const actual = JSON.parse(JSON.stringify(statements)) as unknown;
    if (process.env.WRITE_MIGRATION_SQL_GOLDEN === "1")
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown;
    expect(actual).toEqual(golden);
    // The golden file is not empty by accident: the entries, the defaults and the project rewrite all ran.
    expect(statements.length).toBeGreaterThanOrEqual(8);
    expect(statements.map((statement) => statement.sql).join("\n")).toContain(
      'insert into "model_catalog_entries"',
    );
  });
});
