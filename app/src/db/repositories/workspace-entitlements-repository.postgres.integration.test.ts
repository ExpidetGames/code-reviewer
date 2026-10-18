// SPDX-License-Identifier: Apache-2.0

// The entitlements on Postgres behave like the SQLite ones: the same constraints refuse the same direct
// writes, a reset of the period never goes backwards (also for the default), and a second writer cannot
// race it back. The columns and types are compared with SQLite by the schema parity test in
// ../postgres.integration.test.ts. Runs only when TEST_DATABASE_URL is set.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import type { Database } from "../schema.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import type { EntitlementsData } from "../../workspaces/entitlements.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "./workspace-entitlements-repository.ts";

/** Waits until a backend of the database waits on a lock; bounded, so a bug fails instead of hanging. */
async function waitForLockWait(
  db: Kysely<Database>,
  database: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = ${database} and wait_event_type = 'Lock'`.execute(db);
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline)
      throw new Error("No backend ever waited on the row lock.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const describePostgres = hasPostgres() ? describe : describe.skip;

const NOW = new Date("2026-10-14T12:00:00.000Z");
const ENTITLEMENTS: EntitlementsData = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 5_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

/** Direct writes that the constraints of the table must refuse, whatever the engine. */
const REFUSED_ROWS = [
  ["a key mode the code does not know", "'shared'", "0", "null"],
  ["a suspension flag other than 0 and 1", "'own'", "2", "null"],
  [
    "a suspension code on a workspace that is not suspended",
    "'own'",
    "0",
    "'x'",
  ],
] as const;

describePostgres("the entitlements on Postgres", () => {
  // #271-T08
  it.each(REFUSED_ROWS)(
    "refuse %s, like SQLite",
    async (_name, keyMode, suspended, code) => {
      const postgres = await createPostgresTestDatabase();
      const sqlite = await createTestDatabase();
      const refuse = async (
        db: typeof postgres.db,
        workspaceId: string,
      ): Promise<void> => {
        await expect(
          sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, suspension_code, updated_at)
            values (${workspaceId}, 'x', ${sql.raw(keyMode)}, '{}', '2026-10-01T00:00:00.000Z', ${sql.raw(suspended)}, ${sql.raw(code)}, '2026-10-01T00:00:00.000Z')`.execute(
            db,
          ),
        ).rejects.toThrow();
      };

      await refuse(postgres.db, await defaultWorkspaceId(postgres.db));
      await refuse(sqlite.db, await defaultWorkspaceId(sqlite.db));
    },
  );

  // #271-T08
  it("allows one row per workspace on both engines", async () => {
    const postgres = await createPostgresTestDatabase();
    const workspaceId = await defaultWorkspaceId(postgres.db);
    const insert = () =>
      sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, updated_at)
        values (${workspaceId}, 'x', 'own', '{}', '2026-10-01T00:00:00.000Z', 0, '2026-10-01T00:00:00.000Z')`.execute(
        postgres.db,
      );
    await insert();

    await expect(insert()).rejects.toThrow();
  });

  // #271-T05
  it("never moves the period start of a workspace backwards and accepts the same value again", async () => {
    const postgres = await createPostgresTestDatabase();
    const repository = createWorkspaceEntitlementsRepository(
      postgres.db,
      await defaultWorkspaceId(postgres.db),
      () => NOW,
    );
    await repository.put(ENTITLEMENTS, null);

    await repository.put(ENTITLEMENTS, null);
    await expect(
      repository.put(
        { ...ENTITLEMENTS, periodStart: "2026-09-30T23:59:59.999Z" },
        null,
      ),
    ).rejects.toMatchObject({ code: "period_start_backwards" });

    expect(await repository.get()).toMatchObject({
      periodStart: ENTITLEMENTS.periodStart,
    });
  });

  // #271-T05
  it("never moves the period start of the default backwards and keeps its JSON value", async () => {
    const postgres = await createPostgresTestDatabase();
    const settings = createInstanceSettingsRepository(postgres.db, () => NOW);
    await settings.set("default_entitlements", ENTITLEMENTS, null);

    await expect(
      settings.set(
        "default_entitlements",
        { ...ENTITLEMENTS, periodStart: "2026-09-01T00:00:00.000Z" },
        null,
      ),
    ).rejects.toMatchObject({ code: "period_start_backwards" });

    expect(await settings.getDefaultEntitlements()).toEqual({
      ...ENTITLEMENTS,
      modelAccess: { catalogEntries: null },
    });
  });

  // #428-T06
  it("keeps the stored model access when a put leaves it out, and clears it when told to", async () => {
    const postgres = await createPostgresTestDatabase();
    const repository = createWorkspaceEntitlementsRepository(
      postgres.db,
      await defaultWorkspaceId(postgres.db),
      () => NOW,
    );
    const id = "mce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await repository.put(
      { ...ENTITLEMENTS, modelAccess: { catalogEntries: [id] } },
      null,
    );

    await repository.put({ ...ENTITLEMENTS, planLabel: "other" }, null);
    expect(await repository.get()).toMatchObject({
      planLabel: "other",
      modelAccess: { catalogEntries: [id] },
    });
    await repository.put(
      { ...ENTITLEMENTS, modelAccess: { catalogEntries: null } },
      null,
    );
    expect(await repository.get()).toMatchObject({
      modelAccess: { catalogEntries: null },
    });
  });

  // #271-T05
  it("refuses a reset that was overtaken while it waited for the row", async () => {
    const postgres = await createPostgresTestDatabase();
    const workspaceId = await defaultWorkspaceId(postgres.db);
    const repository = createWorkspaceEntitlementsRepository(
      postgres.db,
      workspaceId,
      () => NOW,
    );
    await repository.put(
      { ...ENTITLEMENTS, periodStart: "2026-10-01T00:00:00.000Z" },
      null,
    );
    // A second connection holds the row with a later start, uncommitted: the reset of day 3 is issued
    // against day 1, waits for the row lock, and by the time it gets the row the stored start is day 5.
    // Without the guard in the statement the late reset would overwrite it.
    const holder = connectPostgres(postgres.url).db;
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    const holding = holder.transaction().execute(async (trx) => {
      await trx
        .updateTable("workspace_entitlements")
        .set({ period_start: "2026-10-05T00:00:00.000Z" })
        .where("workspace_id", "=", workspaceId)
        .execute();
      locked();
      await mayCommit;
    });
    await hasLock;

    const late = repository
      .put({ ...ENTITLEMENTS, periodStart: "2026-10-03T00:00:00.000Z" }, null)
      .then(
        () => "stored",
        (error: unknown) => error,
      );
    await waitForLockWait(postgres.db, postgres.database);
    commit();
    await holding;

    expect(await late).toMatchObject({ code: "period_start_backwards" });
    expect(await repository.get()).toMatchObject({
      periodStart: "2026-10-05T00:00:00.000Z",
    });
  });
});
