// SPDX-License-Identifier: Apache-2.0

// Pins down the data migration that moves the old default Dynamic model name (`deepseek-v4.1-flash`,
// which OpenRouter does not serve) to its OpenRouter id (#262): a stored `dynamicModel` of the old
// name in a project's overrides or in the workspace review defaults becomes `deepseek/deepseek-v4.1-flash`;
// any other model, any other field and any other setting stay as they are, a second run changes nothing,
// and a row that a settings save changed after the migration read it is not overwritten. The same
// suite runs on SQLite and, where TEST_DATABASE_URL is set, on Postgres.
import { join } from "node:path";
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import {
  migration,
  updateDefaultsIfUnchanged,
  updateProjectIfUnchanged,
} from "./migrations/20261014090000_fix_dynamic_default_model.ts";
import type { Database } from "./schema.ts";
import type { Kysely } from "kysely";
import { createIntegrationsRepository } from "./repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories/repositories-repository.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDirectory, track } from "../test-support/test-database.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";

const FIX_DEFAULT_MODEL = "20261014090000_fix_dynamic_default_model";

/** Every migration before the one under test, so the data is the previous release's. */
const providerBefore: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < FIX_DEFAULT_MODEL,
      ),
    );
  },
};

type OpenPreviousRelease = () => Promise<Kysely<Database>>;

const openSqlite: OpenPreviousRelease = async () => {
  const directory = await createTestDirectory();
  return track(
    openDatabase({
      driver: "sqlite",
      path: join(directory, "app.db"),
      busyTimeoutMs: 1000,
    }),
  );
};

const openPostgres: OpenPreviousRelease = async () =>
  (await createPostgresTestDatabase({ migrate: false })).db;

async function startPreviousRelease(open: OpenPreviousRelease) {
  const db = await open();
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
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
    {
      integrationId: integration.id,
      externalId: "7002",
      fullName: "acme/gadgets",
      url: "https://github.test/acme/gadgets",
    },
    {
      integrationId: integration.id,
      externalId: "7003",
      fullName: "acme/gizmos",
      url: "https://github.test/acme/gizmos",
    },
  ]);
  const listed = await repositories.list({ integrationId: integration.id });
  const ids = listed.map((repository) => repository.id);
  return { db, workspaceId, repositoryIds: ids };
}

type Started = Awaited<ReturnType<typeof startPreviousRelease>>;

async function seedProject(
  db: Started["db"],
  id: string,
  repositoryId: string,
  settings: string,
): Promise<void> {
  await db
    .insertInto("projects")
    .values({
      id,
      repository_id: repositoryId,
      active: 1,
      settings,
      created_at: "2026-10-01T09:00:00.000Z",
      updated_at: "2026-10-01T09:00:00.000Z",
    })
    .execute();
}

async function seedReviewDefaults(
  db: Started["db"],
  workspaceId: string,
  value: string,
): Promise<void> {
  await db
    .insertInto("app_settings")
    .values({
      workspace_id: workspaceId,
      key: "review_defaults",
      value,
      updated_at: "2026-10-01T09:00:00.000Z",
      updated_by: "octocat",
    })
    .execute();
}

async function rawSettings(db: Started["db"], id: string): Promise<string> {
  const { rows } = await sql<{
    settings: string;
  }>`select settings from projects where id = ${id}`.execute(db);
  const [row] = rows;
  if (row === undefined) throw new Error("no project");
  return row.settings;
}

async function settingsOf(db: Started["db"], id: string): Promise<unknown> {
  return JSON.parse(await rawSettings(db, id)) as unknown;
}

function suite(open: OpenPreviousRelease) {
  // #262-T03
  it("moves the old default name to the OpenRouter id and leaves everything else alone", async () => {
    const { db, workspaceId, repositoryIds } = await startPreviousRelease(open);
    const [first, second] = repositoryIds;
    if (first === undefined || second === undefined)
      throw new Error("no repositories");
    await seedProject(
      db,
      "old-default",
      first,
      JSON.stringify({
        reviewKind: "dynamic",
        dynamicModel: "deepseek-v4.1-flash",
        maxFindings: 3,
      }),
    );
    await seedProject(
      db,
      "other-model",
      second,
      JSON.stringify({
        reviewKind: "dynamic",
        dynamicModel: "anthropic/claude-haiku-5.5",
      }),
    );
    await seedReviewDefaults(
      db,
      workspaceId,
      JSON.stringify({ dynamicModel: "deepseek-v4.1-flash", maxTokens: 5000 }),
    );

    await migrateToLatest(db);

    expect(await settingsOf(db, "old-default")).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "deepseek/deepseek-v4.1-flash",
      maxFindings: 3,
    });
    expect(await settingsOf(db, "other-model")).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "anthropic/claude-haiku-5.5",
    });
    const { rows } = await sql<{
      value: string;
    }>`select value from app_settings where key = 'review_defaults'`.execute(
      db,
    );
    expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({
      dynamicModel: "deepseek/deepseek-v4.1-flash",
      maxTokens: 5000,
    });
  });

  // #262-T03
  it("keeps settings without a Dynamic model, other names, unreadable and non-object settings unchanged", async () => {
    const { db, workspaceId, repositoryIds } = await startPreviousRelease(open);
    const [first, second, third] = repositoryIds;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("no repositories");
    await seedProject(db, "empty", first, "{}");
    await seedProject(db, "broken", second, "not json");
    await seedProject(
      db,
      "lookalike",
      third,
      JSON.stringify({ dynamicModel: " deepseek-v4.1-flash" }),
    );
    await seedReviewDefaults(db, workspaceId, "[]");

    await migrateToLatest(db);

    expect(await settingsOf(db, "empty")).toEqual({});
    expect(await rawSettings(db, "broken")).toBe("not json");
    expect(await settingsOf(db, "lookalike")).toEqual({
      dynamicModel: " deepseek-v4.1-flash",
    });
    const { rows } = await sql<{
      value: string;
    }>`select value from app_settings where key = 'review_defaults'`.execute(
      db,
    );
    expect(rows[0]?.value).toBe("[]");
  });

  // #262-T03
  it.each(["null", "[]", '"deepseek-v4.1-flash"', "5", "  "])(
    "leaves the settings text %j alone",
    async (text) => {
      const { db, repositoryIds } = await startPreviousRelease(open);
      const [first] = repositoryIds;
      if (first === undefined) throw new Error("no repository");
      await seedProject(db, "odd", first, text);

      await migrateToLatest(db);

      expect(await rawSettings(db, "odd")).toBe(text);
    },
  );

  // #262-T03
  it("rewrites settings that are written with whitespace and keeps their other fields", async () => {
    const { db, repositoryIds } = await startPreviousRelease(open);
    const [first] = repositoryIds;
    if (first === undefined) throw new Error("no repository");
    await seedProject(
      db,
      "pretty",
      first,
      '  {\n    "maxFindings": 4,\n    "dynamicModel" : "deepseek-v4.1-flash"\n  }\n',
    );

    await migrateToLatest(db);

    expect(await settingsOf(db, "pretty")).toEqual({
      maxFindings: 4,
      dynamicModel: "deepseek/deepseek-v4.1-flash",
    });
  });

  // #262-T03
  it("changes nothing when the same migration body runs again", async () => {
    const { db, workspaceId, repositoryIds } = await startPreviousRelease(open);
    const [first] = repositoryIds;
    if (first === undefined) throw new Error("no repository");
    await seedProject(
      db,
      "again",
      first,
      JSON.stringify({ dynamicModel: "deepseek-v4.1-flash" }),
    );
    await seedReviewDefaults(
      db,
      workspaceId,
      JSON.stringify({ dynamicModel: "deepseek-v4.1-flash" }),
    );
    await migrateToLatest(db);
    const before = await rawSettings(db, "again");

    await migration.up(db);
    await migration.up(db);

    expect(await rawSettings(db, "again")).toBe(before);
  });

  // #262-T03
  it("does not overwrite settings that were saved after the migration read them", async () => {
    const { db, workspaceId, repositoryIds } = await startPreviousRelease(open);
    const [first] = repositoryIds;
    if (first === undefined) throw new Error("no repository");
    const read = JSON.stringify({ dynamicModel: "deepseek-v4.1-flash" });
    const saved = JSON.stringify({ dynamicModel: "acme/own-model" });
    await seedProject(db, "raced", first, saved);
    await seedReviewDefaults(db, workspaceId, saved);

    const next = JSON.stringify({
      dynamicModel: "deepseek/deepseek-v4.1-flash",
    });
    expect(await updateProjectIfUnchanged(db, "raced", read, next)).toBe(false);
    expect(
      await updateDefaultsIfUnchanged(
        db,
        { workspaceId, key: "review_defaults" },
        read,
        next,
      ),
    ).toBe(false);

    expect(await settingsOf(db, "raced")).toEqual({
      dynamicModel: "acme/own-model",
    });
    const { rows } = await sql<{
      value: string;
    }>`select value from app_settings where key = 'review_defaults'`.execute(
      db,
    );
    expect(rows[0]?.value).toBe(saved);
  });
}

describe("the migration that fixes the default Dynamic model on SQLite", () => {
  suite(openSqlite);
});

const describePostgres = hasPostgres() ? describe : describe.skip;

describePostgres(
  "the migration that fixes the default Dynamic model on Postgres",
  () => {
    suite(openPostgres);
  },
);
