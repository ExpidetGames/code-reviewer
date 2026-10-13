// SPDX-License-Identifier: Apache-2.0

// Concurrent settings changes on Postgres: two instances read-modify-write the same project, and no
// update is lost. SQLite serializes them with its single write lock (`begin immediate`); Postgres
// needs the workspace-scoped repository row locked before the read, which this test pins. Runs only
// when TEST_DATABASE_URL is set.
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import type { Database } from "../schema.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

/** `postgres://...?application_name=<name>`, so a backend can be found in `pg_stat_activity`. */
function withApplicationName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

/** Waits until the backend of `name` is waiting on a lock; bounded, so a bug fails instead of hanging. */
async function waitForLockWait(
  db: Kysely<Database>,
  name: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${name} and wait_event_type = 'Lock'`.execute(
      db,
    );
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Backend ${name} never waited on a lock.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describePostgres("concurrent project settings changes on Postgres", () => {
  // #194-T07
  it("do not lose an update: the second writer reads what the first one stored", async () => {
    const postgres = await createPostgresTestDatabase();
    const workspaceId = await defaultWorkspaceId(postgres.db);
    const integration = await createIntegrationsRepository(
      postgres.db,
      workspaceId,
    ).create({
      type: "github_app",
      displayName: "acme",
      externalId: "4242",
      config: {},
    });
    const repositories = createRepositoriesRepository(postgres.db, workspaceId);
    await repositories.reconcile(integration.id, [
      {
        integrationId: integration.id,
        externalId: "1",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
    ]);
    const [repository] = await repositories.list();
    if (repository === undefined) throw new Error("seeding failed");
    await createProjectsRepository(postgres.db, workspaceId).updateSettings(
      repository.id,
      { model: "vendor/diff", maxFindings: 2 },
    );

    const firstConnection = connectPostgres(postgres.url);
    const secondConnection = connectPostgres(
      withApplicationName(postgres.url, "cr_waiter"),
    );

    // The first writer changes the Dynamic model, then holds its transaction open before committing.
    let firstWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      firstWritten = resolve;
    });
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = createProjectsRepository(
      firstConnection.db,
      workspaceId,
    ).updateSettingsWith(
      repository.id,
      (current) => ({ ...current, dynamicModel: "vendor/new" }),
      async () => {
        firstWritten();
        await held;
      },
    );
    await written;

    // The second writer changes another field. Without the row lock it reads the settings from before
    // the first writer committed, then its write overwrites the first writer's Dynamic model.
    const second = createProjectsRepository(
      secondConnection.db,
      workspaceId,
    ).updateSettingsWith(repository.id, (current) => ({
      ...current,
      maxFindings: 9,
    }));
    await waitForLockWait(postgres.db, "cr_waiter");
    releaseFirst();
    await Promise.all([first, second]);

    const stored = (
      await createProjectsRepository(postgres.db, workspaceId).get(
        repository.id,
      )
    )?.settings;
    expect(stored).toEqual({
      model: "vendor/diff",
      maxFindings: 9,
      dynamicModel: "vendor/new",
    });

    await firstConnection.close();
    await secondConnection.close();
  });
});
