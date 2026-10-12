// SPDX-License-Identifier: Apache-2.0

// The sync lock of the large topology (PG-12): on Postgres two app instances serialize on the same
// installation through an advisory lock, so a reconciliation that runs at the same moment cannot
// insert the same repository twice (which would abort one instance with a unique violation). Runs
// only when TEST_DATABASE_URL is set.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../db/repositories/repositories-repository.ts";
import type { Database } from "../../db/schema.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { defaultKeyedLock } from "./keyed-lock.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

function withApplicationName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

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

describePostgres("the sync lock on Postgres", () => {
  // #105-PG-12
  it("makes a second instance wait for the one that holds the installation", async () => {
    const postgres = await createPostgresTestDatabase();
    const first = connectPostgres(postgres.url);
    const second = connectPostgres(
      withApplicationName(postgres.url, "cr_sync"),
    );
    const lockA = defaultKeyedLock(first.db);
    const lockB = defaultKeyedLock(second.db);
    const key = "github_app:4242";

    let releaseA = (): void => undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aInside = (): void => undefined;
    const aEntered = new Promise<void>((resolve) => {
      aInside = resolve;
    });
    let bRan = false;

    const runA = lockA.run(key, async () => {
      aInside();
      await holdA;
    });
    await aEntered;
    const runB = lockB.run(key, async () => {
      bRan = true;
    });
    // While A holds the lock, B is waiting in the database and its job has not started.
    await waitForLockWait(postgres.db, "cr_sync");
    expect(bRan).toBe(false);

    releaseA();
    await Promise.all([runA, runB]);
    expect(bRan).toBe(true);
    await first.close();
    await second.close();
  });

  // #105-PG-12
  it("reconciles one installation from two instances without a duplicate row or an abort", async () => {
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
    const discovered = [
      {
        integrationId: integration.id,
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
    ];

    const first = connectPostgres(postgres.url);
    const second = connectPostgres(postgres.url);
    const key = `github_app:${integration.id}`;
    const [, secondResult] = await Promise.all([
      defaultKeyedLock(first.db).run(key, () =>
        createRepositoriesRepository(first.db, workspaceId).reconcile(
          integration.id,
          discovered,
        ),
      ),
      defaultKeyedLock(second.db).run(key, () =>
        createRepositoriesRepository(second.db, workspaceId).reconcile(
          integration.id,
          discovered,
        ),
      ),
    ]);
    await first.close();
    await second.close();

    // Neither instance aborted, and the repository exists once.
    expect(secondResult).toBeDefined();
    const rows = await postgres.db
      .selectFrom("repositories")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe("7001");
  });

  // #105-PG-12 (review): the lock must not hold a pooled connection, or the job's own DB work
  // deadlocks the main pool when about `poolMax` runs happen at once.
  it("completes many concurrent runs on a pool of two, keeping the same key exclusive", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 2 });
    const lock = defaultKeyedLock(postgres.db);

    let onSameKey = 0;
    let mostOnSameKey = 0;
    const run = (key: string, index: number) =>
      lock.run(key, async () => {
        if (key === "same") {
          onSameKey += 1;
          mostOnSameKey = Math.max(mostOnSameKey, onSameKey);
        }
        // Real database work on the main pool while the lock is held.
        const { rows } = await sql<{ one: number }>`
          select 1 as one`.execute(postgres.db);
        if (rows[0]?.one !== 1) throw new Error("unexpected database answer");
        if (key === "same") onSameKey -= 1;
        return index;
      });

    const results = await Promise.all([
      run("same", 0),
      run("same", 1),
      run("a", 2),
      run("b", 3),
      run("c", 4),
      run("d", 5),
    ]);

    expect(results).toHaveLength(6);
    expect(mostOnSameKey).toBe(1);
  });

  // #105-PG-12 (review): a throwing job releases its lock.
  it("releases the lock when the job throws", async () => {
    const postgres = await createPostgresTestDatabase();
    const lock = defaultKeyedLock(postgres.db);

    await expect(
      lock.run("key", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(lock.run("key", async () => "free")).resolves.toBe("free");
  });
});
