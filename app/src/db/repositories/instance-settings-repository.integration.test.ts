// SPDX-License-Identifier: Apache-2.0

// Pins down the instance settings repository against a real SQLite file: a setting without a row
// reads as undefined (never as a guess), a value round-trips as JSON, and a second write replaces
// the value and records who and when.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";

describe("the instance settings repository", () => {
  it("returns undefined for a setting that has no row", async () => {
    const { db } = await createTestDatabase();

    expect(
      await createInstanceSettingsRepository(db).get("setup_completed_at"),
    ).toBeUndefined();
  });

  it("stores a value as JSON text and reads back the same value", async () => {
    const { db } = await createTestDatabase();
    const repository = createInstanceSettingsRepository(db);

    await repository.set(
      "sign_up_rule",
      { kind: "domains", entries: ["example.com"] },
      null,
    );
    await repository.set("setup_completed_at", null, null);

    expect(await repository.get("sign_up_rule")).toEqual({
      kind: "domains",
      entries: ["example.com"],
    });
    expect(await repository.get("setup_completed_at")).toBeNull();
    const { rows } = await sql<{
      type: string;
    }>`select typeof(value) as type from instance_settings`.execute(db);
    expect(rows.every((row) => row.type === "text")).toBe(true);
  });

  it("replaces the value of an existing setting and records who changed it and when", async () => {
    const { db } = await createTestDatabase();
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u1', 'Admin', 'admin@example.test', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    let now = new Date("2026-10-11T08:00:00.000Z");
    const repository = createInstanceSettingsRepository(db, () => now);

    await repository.set("tenancy", "single", null);
    now = new Date("2026-10-11T09:00:00.000Z");
    await repository.set("tenancy", "multi", "u1");

    expect(await repository.get("tenancy")).toBe("multi");
    const { rows } =
      await sql`select key, updated_by, updated_at from instance_settings`.execute(
        db,
      );
    expect(rows).toEqual([
      {
        key: "tenancy",
        updated_by: "u1",
        updated_at: "2026-10-11T09:00:00.000Z",
      },
    ]);
  });

  it("keeps the setting when the user who saved it is deleted", async () => {
    const { db } = await createTestDatabase();
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u1', 'Admin', 'admin@example.test', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    const repository = createInstanceSettingsRepository(db);
    await repository.set("tenancy", "single", "u1");

    await sql`delete from users where id = 'u1'`.execute(db);

    expect(await repository.get("tenancy")).toBe("single");
    const { rows } =
      await sql`select updated_by from instance_settings`.execute(db);
    expect(rows).toEqual([{ updated_by: null }]);
  });
});

describe("the instance settings repository, with who and when", () => {
  // #98-AD-14
  it("reads a setting together with the user who saved it and the time", async () => {
    const { db } = await createTestDatabase();
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u1', 'Admin', 'admin@example.test', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    const repository = createInstanceSettingsRepository(
      db,
      () => new Date("2026-10-11T09:30:00.000Z"),
    );

    await repository.set("max_workspaces_per_user", 12, "u1");

    expect(await repository.getWithMeta("max_workspaces_per_user")).toEqual({
      value: 12,
      updatedBy: "u1",
      updatedAt: "2026-10-11T09:30:00.000Z",
    });
  });

  it("reads undefined with the meta call for a setting that has no row", async () => {
    const { db } = await createTestDatabase();

    expect(
      await createInstanceSettingsRepository(db).getWithMeta("tenancy"),
    ).toBeUndefined();
  });
});
