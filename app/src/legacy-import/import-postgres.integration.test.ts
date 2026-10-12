// SPDX-License-Identifier: Apache-2.0

// Two app instances starting on one Postgres must import an existing installation exactly once. The
// guard inside the import transaction locks the `import_state` row, which a plain read does not: this
// test holds the first instance's transaction open at the workspace step, starts the second, proves
// it waits on the lock, then lets the first commit. Runs only when TEST_DATABASE_URL is set.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import {
  importExistingInstallation,
  type ImportDependencies,
} from "./import.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;
const SECRET = "postgres-import-secret-0123456789-abcdef";

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

async function addUser(db: Kysely<Database>, id: string, login: string) {
  await db
    .insertInto("users")
    .values({
      id,
      name: login,
      email: `${login}@example.test`,
      email_verified: 1,
      github_login: login,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:00:00.000Z",
    })
    .execute();
}

describePostgres("the import of a legacy installation on Postgres", () => {
  // #105 (review: the import guard)
  it("imports once when two instances start at the same moment", async () => {
    const postgres = await createPostgresTestDatabase();
    await addUser(postgres.db, "user-1", "alice");
    await addUser(postgres.db, "user-2", "bob");
    // Seed the marker (the value a legacy install reads as "none") before any transaction: the
    // guards below then do nothing on their own, so only `select ... for update` serializes the two
    // instances. Removing it alone makes this test red.
    await createInstanceSettingsRepository(postgres.db).set(
      "import_state",
      "none",
      null,
    );

    const first = connectPostgres(postgres.url);
    const second = connectPostgres(
      withApplicationName(postgres.url, "cr_import"),
    );
    const env = {
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
    };
    const dependencies = (
      db: Kysely<Database>,
      afterStep?: ImportDependencies["afterStep"],
    ): ImportDependencies => ({
      db,
      env,
      appSecret: SECRET,
      decryptToken: async () => {
        throw new Error("no legacy token is configured");
      },
      checkMembership: async () => {
        throw new Error("no organization is configured");
      },
      log: {
        info: () => undefined,
        warn: () => undefined,
      },
      now: () => new Date("2026-10-12T09:00:00.000Z"),
      afterStep,
    });

    // Hold the first import's transaction open at its first step, so the second must contend for the
    // `import_state` row lock instead of racing past a plain read.
    let releaseFirst = (): void => undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAtWorkspace = (): void => undefined;
    const firstReached = new Promise<void>((resolve) => {
      firstAtWorkspace = resolve;
    });

    const firstImport = importExistingInstallation(
      dependencies(first.db, async (step) => {
        if (step !== "workspace") return;
        firstAtWorkspace();
        await holdFirst;
      }),
    );
    await firstReached;

    const secondImport = importExistingInstallation(dependencies(second.db));
    await waitForLockWait(postgres.db, "cr_import");
    releaseFirst();

    const [firstOutcome, secondOutcome] = await Promise.all([
      firstImport,
      secondImport,
    ]);
    await first.close();
    await second.close();

    // One imported, the other waited and did nothing; the database holds one workspace.
    expect(firstOutcome.kind).toBe("imported");
    expect(secondOutcome.kind).toBe("not_needed");
    expect(
      (await createWorkspacesRepository(postgres.db).findDefault())?.slug,
    ).toBe("default");
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from workspaces`.execute(postgres.db);
    expect(rows[0]?.count).toBe(1);
  });
});
