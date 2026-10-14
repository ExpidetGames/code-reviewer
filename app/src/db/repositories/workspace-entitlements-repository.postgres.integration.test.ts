// SPDX-License-Identifier: Apache-2.0

// The entitlements on Postgres behave like the SQLite ones: the same constraints refuse the same direct
// writes, a reset of the period never goes backwards (also for the default), and a second writer cannot
// race it back. The columns and types are compared with SQLite by the schema parity test in
// ../postgres.integration.test.ts. Runs only when TEST_DATABASE_URL is set.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import type { EntitlementsData } from "../../workspaces/entitlements.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "./workspace-entitlements-repository.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const NOW = new Date("2026-10-14T12:00:00.000Z");
const ENTITLEMENTS: EntitlementsData = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 5_000_000,
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

    expect(await settings.get("default_entitlements")).toEqual(ENTITLEMENTS);
  });

  // #271-T05
  it("lets only the latest of concurrent resets win", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 8 });
    const repository = createWorkspaceEntitlementsRepository(
      postgres.db,
      await defaultWorkspaceId(postgres.db),
      () => NOW,
    );
    const starts = [1, 2, 3, 4, 5, 6].map(
      (day) => `2026-10-0${day}T00:00:00.000Z`,
    );

    await Promise.allSettled(
      starts.map((periodStart) =>
        repository.put({ ...ENTITLEMENTS, periodStart }, null),
      ),
    );

    expect(await repository.get()).toMatchObject({
      periodStart: "2026-10-06T00:00:00.000Z",
    });
  });
});
