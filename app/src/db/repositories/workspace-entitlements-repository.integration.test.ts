// SPDX-License-Identifier: Apache-2.0

// The entitlements of a workspace against a real SQLite file: a row round-trips, a reset of the period
// never goes backwards (and a repeat is harmless), a suspension is set and cleared together with its code,
// and the instance default is validated the same way. Isolation between workspaces is in
// scoped-isolation.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import {
  INVALID_ENTITLEMENTS,
  resolveEntitlements,
  type EntitlementsData,
} from "../../workspaces/entitlements.ts";
import { EntitlementsError } from "../../workspaces/entitlements-validation.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "./workspace-entitlements-repository.ts";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function entitlements(overrides: Partial<EntitlementsData> = {}) {
  return {
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
    ...overrides,
  } satisfies EntitlementsData;
}

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  let now = NOW;
  const repository = createWorkspaceEntitlementsRepository(
    db,
    workspaceId,
    () => now,
  );
  return {
    db,
    workspaceId,
    repository,
    setNow: (next: Date) => {
      now = next;
    },
  };
}

describe("the entitlements repository of a workspace", () => {
  it("has no row for a workspace that never had entitlements", async () => {
    const { repository } = await setup();

    expect(await repository.get()).toBeUndefined();
  });

  it("stores a row and reads it back with who saved it and when", async () => {
    const { db, repository } = await setup();
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u1', 'Ops', 'ops@example.test', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );

    await repository.put(entitlements(), "u1");

    expect(await repository.get()).toEqual({
      ...entitlements(),
      updatedBy: "u1",
      updatedAt: "2026-10-14T12:00:00.000Z",
    });
  });

  it("records the operator API, which has no user, as a null updater", async () => {
    const { repository } = await setup();

    await repository.put(entitlements(), null);

    expect(await repository.get()).toMatchObject({ updatedBy: null });
  });

  it("stores the limits as JSON text and the flag as an integer", async () => {
    const { db, repository } = await setup();

    await repository.put(entitlements({ suspended: true }), null);

    const { rows } = await sql<{
      limits: string;
      suspended: number;
      kind: string;
    }>`select limits, suspended, typeof(limits) as kind from workspace_entitlements`.execute(
      db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("text");
    expect(JSON.parse(rows[0]?.limits ?? "")).toEqual(entitlements().limits);
    expect(rows[0]?.suspended).toBe(1);
  });

  it("replaces the row on a second put", async () => {
    const { repository } = await setup();
    await repository.put(entitlements(), null);

    await repository.put(entitlements({ planLabel: "large" }), null);

    expect(await repository.get()).toMatchObject({ planLabel: "large" });
  });

  it("refuses an invalid input with its stable code and stores nothing", async () => {
    const { repository } = await setup();

    await expect(
      repository.put(
        entitlements({
          limits: {
            diffRunsPerPeriod: -1,
            dynamicRunsPerPeriod: null,
            managedCostLimitMicroUsd: null,
          },
        }),
        null,
      ),
    ).rejects.toMatchObject({
      name: "EntitlementsError",
      code: "limit_invalid",
      field: "diffRunsPerPeriod",
    });
    expect(await repository.get()).toBeUndefined();
  });

  describe("a row that cannot be read", () => {
    async function insertRaw(
      db: Awaited<ReturnType<typeof setup>>["db"],
      workspaceId: string,
      overrides: { limits?: string; period_start?: string } = {},
    ) {
      const row = {
        workspace_id: workspaceId,
        plan_label: "team",
        key_mode: "managed",
        limits: JSON.stringify(entitlements().limits),
        period_start: "2026-10-01T00:00:00.000Z",
        suspended: 0,
        suspension_code: null,
        updated_at: "2026-10-13T08:00:00.000Z",
        updated_by: null,
        ...overrides,
      };
      await db.insertInto("workspace_entitlements").values(row).execute();
    }

    // #271-T10
    it.each([
      ["limits that lack a key", '{"diffRunsPerPeriod":1}'],
      ["limits that are an empty object", "{}"],
      [
        "limits with a value that is not a count",
        '{"diffRunsPerPeriod":-5,"dynamicRunsPerPeriod":null,"managedCostLimitMicroUsd":null}',
      ],
      ["limits that are damaged JSON", "{not json"],
      ["limits that are JSON null", "null"],
    ])("reads %s as invalid, without throwing", async (_name, limits) => {
      const { db, workspaceId, repository } = await setup();
      await insertRaw(db, workspaceId, { limits });

      const stored = await repository.get();

      expect(stored).toEqual({
        ...INVALID_ENTITLEMENTS,
        updatedBy: null,
        updatedAt: "2026-10-13T08:00:00.000Z",
      });
      expect(resolveEntitlements(stored, undefined)).toEqual({
        kind: "invalid",
        code: "entitlements_invalid",
        source: "workspace",
      });
    });

    // #271-T10
    it("reads a period start that is not a time as invalid", async () => {
      const { db, workspaceId, repository } = await setup();
      await insertRaw(db, workspaceId, { period_start: "garbage" });

      expect(await repository.get()).toMatchObject({ invalid: true });
    });

    // #271-T10
    it("never resolves to unlimited, not even when the default would be", async () => {
      const { db, workspaceId, repository } = await setup();
      await insertRaw(db, workspaceId, { limits: "{}" });

      expect(
        resolveEntitlements(await repository.get(), undefined),
      ).toMatchObject({ kind: "invalid" });
    });

    // #271-T10
    it("can be replaced by a valid put, which repairs it", async () => {
      const { db, workspaceId, repository } = await setup();
      await insertRaw(db, workspaceId, { limits: "{}" });

      await repository.put(entitlements(), null);

      expect(await repository.get()).toMatchObject({ planLabel: "team" });
      expect(await repository.get()).not.toHaveProperty("invalid");
    });

    // #271-T10
    it("keeps a row that lacks a limit a later version added readable (the key reads as unlimited)", async () => {
      // LIMITS_ADDED_LATER is empty today, so the guarantee is pinned in entitlements-validation.test.ts;
      // here: a row with an extra key of a newer version is still read.
      const { db, workspaceId, repository } = await setup();
      await insertRaw(db, workspaceId, {
        limits: JSON.stringify({ ...entitlements().limits, newerLimit: 3 }),
      });

      expect(await repository.get()).toMatchObject({
        planLabel: "team",
        limits: entitlements().limits,
      });
    });
  });

  describe("the period start", () => {
    // #271-T05
    it("refuses a value earlier than the stored one and leaves the row as it was", async () => {
      const { repository } = await setup();
      await repository.put(entitlements(), null);

      await expect(
        repository.put(
          entitlements({
            planLabel: "changed",
            periodStart: "2026-09-30T23:59:59.999Z",
          }),
          null,
        ),
      ).rejects.toMatchObject({ code: "period_start_backwards" });

      expect(await repository.get()).toMatchObject({
        planLabel: "team",
        periodStart: "2026-10-01T00:00:00.000Z",
      });
    });

    // #271-T05
    it("accepts the same value again as a no-op for the period", async () => {
      const { repository } = await setup();
      await repository.put(entitlements(), null);

      await repository.put(entitlements(), null);

      expect(await repository.get()).toMatchObject({
        periodStart: "2026-10-01T00:00:00.000Z",
      });
    });

    it("accepts a later value", async () => {
      const { repository } = await setup();
      await repository.put(entitlements(), null);

      await repository.put(
        entitlements({ periodStart: "2026-10-14T00:00:00.000Z" }),
        null,
      );

      expect(await repository.get()).toMatchObject({
        periodStart: "2026-10-14T00:00:00.000Z",
      });
    });

    it("refuses a start more than a few minutes ahead of the clock", async () => {
      const { repository } = await setup();

      await expect(
        repository.put(
          entitlements({ periodStart: "2026-10-14T12:06:00.000Z" }),
          null,
        ),
      ).rejects.toMatchObject({ code: "period_start_in_future" });
    });

    it("compares the instants, not the way the text was written", async () => {
      const { repository } = await setup();
      await repository.put(entitlements(), null);

      await repository.put(
        entitlements({ periodStart: "2026-10-01T00:00:00Z" }),
        null,
      );

      expect(await repository.get()).toMatchObject({
        periodStart: "2026-10-01T00:00:00.000Z",
      });
    });
  });

  describe("suspension", () => {
    // #271-T09
    it("is set with its code and cleared together with it, and the resolver follows", async () => {
      const { repository } = await setup();
      await repository.put(
        entitlements({ suspended: true, suspensionCode: "payment_overdue" }),
        null,
      );
      const suspended = await repository.get();

      expect(resolveEntitlements(suspended, undefined)).toMatchObject({
        kind: "limited",
        suspended: true,
        suspensionCode: "payment_overdue",
      });

      await repository.put(
        entitlements({ suspended: false, suspensionCode: "payment_overdue" }),
        null,
      );
      const cleared = await repository.get();

      expect(cleared).toMatchObject({ suspended: false, suspensionCode: null });
      expect(resolveEntitlements(cleared, undefined)).toMatchObject({
        suspended: false,
        suspensionCode: null,
      });
    });

    it("cannot be stored as not suspended with a code, even by a direct write", async () => {
      const { db, workspaceId } = await setup();

      await expect(
        sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, suspension_code, updated_at)
          values (${workspaceId}, 'x', 'own', '{}', '2026-10-01T00:00:00.000Z', 0, 'oops', '2026-10-01T00:00:00.000Z')`.execute(
          db,
        ),
      ).rejects.toThrow(/constraint/i);
    });

    it("cannot be stored with a key mode other than own or managed, even by a direct write", async () => {
      const { db, workspaceId } = await setup();

      await expect(
        sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, updated_at)
          values (${workspaceId}, 'x', 'shared', '{}', '2026-10-01T00:00:00.000Z', 0, '2026-10-01T00:00:00.000Z')`.execute(
          db,
        ),
      ).rejects.toThrow(/constraint/i);
    });
  });

  it("goes with its workspace", async () => {
    const { db } = await createTestDatabase();
    const other = await addWorkspace(db, "other");
    await createWorkspaceEntitlementsRepository(db, other, () => NOW).put(
      entitlements(),
      null,
    );

    await sql`delete from workspaces where id = ${other}`.execute(db);

    const { rows } = await sql`select * from workspace_entitlements`.execute(
      db,
    );
    expect(rows).toEqual([]);
  });
});

describe("the default entitlements of the instance", () => {
  it("has no row until it is set, which leaves every workspace unlimited", async () => {
    const { db, repository } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);

    expect(await settings.getDefaultEntitlements()).toBeUndefined();
    expect(
      resolveEntitlements(
        await repository.get(),
        await settings.getDefaultEntitlements(),
      ),
    ).toEqual({ kind: "unlimited" });
  });

  it("applies to a workspace without a row and not to one with a row", async () => {
    const { db, repository } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);
    await settings.set(
      "default_entitlements",
      entitlements({ planLabel: "starter" }),
      null,
    );

    const fromDefault = resolveEntitlements(
      await repository.get(),
      await settings.getDefaultEntitlements(),
    );
    await repository.put(entitlements({ planLabel: "team" }), null);
    const fromRow = resolveEntitlements(
      await repository.get(),
      await settings.getDefaultEntitlements(),
    );

    expect(fromDefault).toMatchObject({
      source: "default",
      planLabel: "starter",
    });
    expect(fromRow).toMatchObject({ source: "workspace", planLabel: "team" });
  });

  // #271-T10
  it("reads a default that is damaged or invalid as invalid, and a workspace without a row resolves to invalid", async () => {
    const { db, repository } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);
    for (const value of ["{not json", '{"planLabel":"x"}', "null"]) {
      await sql`delete from instance_settings`.execute(db);
      await sql`insert into instance_settings (key, value, updated_by, updated_at)
        values ('default_entitlements', ${value}, null, '2026-10-13T08:00:00.000Z')`.execute(
        db,
      );

      const stored = await settings.getDefaultEntitlements();

      expect(stored).toEqual(INVALID_ENTITLEMENTS);
      expect(resolveEntitlements(await repository.get(), stored)).toEqual({
        kind: "invalid",
        code: "entitlements_invalid",
        source: "default",
      });
    }
  });

  // #271-T10
  it("reads a default that a newer version wrote with an extra key", async () => {
    const { db } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);
    await sql`insert into instance_settings (key, value, updated_by, updated_at)
      values ('default_entitlements', ${JSON.stringify({ ...entitlements(), newer: 1 })}, null, '2026-10-13T08:00:00.000Z')`.execute(
      db,
    );

    expect(await settings.getDefaultEntitlements()).toEqual(entitlements());
  });

  // #271-T04
  it("refuses an invalid default with its stable code and stores nothing", async () => {
    const { db } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);

    await expect(
      settings.set(
        "default_entitlements",
        entitlements({ keyMode: "shared" as "own" }),
        null,
      ),
    ).rejects.toBeInstanceOf(EntitlementsError);
    expect(await settings.getDefaultEntitlements()).toBeUndefined();
  });

  // #271-T05
  it("never moves the period start of the default backwards, and accepts the same value again", async () => {
    const { db } = await setup();
    const settings = createInstanceSettingsRepository(db, () => NOW);
    await settings.set("default_entitlements", entitlements(), null);

    await settings.set("default_entitlements", entitlements(), null);
    await expect(
      settings.set(
        "default_entitlements",
        entitlements({ periodStart: "2026-09-01T00:00:00.000Z" }),
        null,
      ),
    ).rejects.toMatchObject({ code: "period_start_backwards" });

    expect(await settings.getDefaultEntitlements()).toEqual(entitlements());
  });
});
