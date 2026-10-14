// SPDX-License-Identifier: Apache-2.0

// Pins down the data migration that moves the old default Dynamic model name (`deepseek-v4.1-flash`,
// which OpenRouter does not serve) to its OpenRouter id (#262): a stored `dynamicModel` of the old
// name in a project's overrides or in the workspace review defaults becomes `deepseek/deepseek-v4.1-flash`;
// any other model, any other field and any other setting stay as they are, and a restart changes nothing.
import { join } from "node:path";
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import { createIntegrationsRepository } from "./repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories/repositories-repository.ts";
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

async function startPreviousRelease() {
  const directory = await createTestDirectory();
  const db = track(
    openDatabase({
      driver: "sqlite",
      path: join(directory, "app.db"),
      busyTimeoutMs: 1000,
    }),
  );
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

async function settingsOf(db: Started["db"], id: string): Promise<unknown> {
  const { rows } = await sql<{
    settings: string;
  }>`select settings from projects where id = ${id}`.execute(db);
  const [row] = rows;
  if (row === undefined) throw new Error("no project");
  return JSON.parse(row.settings) as unknown;
}

describe("the migration that fixes the default Dynamic model", () => {
  // #262-T03
  it("moves the old default name to the OpenRouter id and leaves everything else alone", async () => {
    const { db, workspaceId, repositoryIds } = await startPreviousRelease();
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
  it("keeps settings without a Dynamic model, unreadable settings and a second start unchanged", async () => {
    const { db, repositoryIds } = await startPreviousRelease();
    const [first, second] = repositoryIds;
    if (first === undefined || second === undefined)
      throw new Error("no repositories");
    await seedProject(db, "empty", first, "{}");
    await seedProject(db, "broken", second, "not json");

    await migrateToLatest(db);
    await migrateToLatest(db);

    expect(await settingsOf(db, "empty")).toEqual({});
    const { rows } = await sql<{
      settings: string;
    }>`select settings from projects where id = 'broken'`.execute(db);
    expect(rows[0]?.settings).toBe("not json");
  });
});
