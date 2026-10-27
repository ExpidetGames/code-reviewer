// SPDX-License-Identifier: LicenseRef-Proprietary

// The generic store behind the instance settings (#715, cut 2) against a real Postgres database. A domain reads and
// writes the keys it owns through the store with its own value types; the plain reads and writes of the
// repository of the whole instance are these (`instance-settings-repository.integration.test.ts` runs them through it).
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { createInstanceSettingsStore } from "./instance-settings-store.ts";

type Domain = {
  tenancy: "single" | "multi";
  billing_destination_lock: { startedAt: string };
};

describe("the instance settings store", () => {
  // #715-T03
  it("reads a key the domain owns as undefined without a row, then writes and reads it back with who and when", async () => {
    const { db } = await createTestDatabase();
    const store = createInstanceSettingsStore<Domain>(
      db,
      () => new Date("2026-10-26T10:00:00.000Z"),
    );

    expect(await store.get("tenancy")).toBeUndefined();
    expect(await store.getWithMeta("tenancy")).toBeUndefined();
    await store.set("tenancy", "multi", null);

    expect(await store.get("tenancy")).toBe("multi");
    expect(await store.getWithMeta("tenancy")).toEqual({
      value: "multi",
      updatedBy: null,
      updatedAt: "2026-10-26T10:00:00.000Z",
    });
    const { rows } =
      await sql`select key, value from instance_settings`.execute(db);
    expect(rows).toEqual([{ key: "tenancy", value: '"multi"' }]);
  });

  // #715-T03
  it("shares its rows with the repository of the whole instance", async () => {
    const { db } = await createTestDatabase();
    const store = createInstanceSettingsStore<Domain>(db);

    await store.set("tenancy", "single", null);
    await createInstanceSettingsRepository(db).set("tenancy", "multi", null);

    expect(await store.get("tenancy")).toBe("multi");
    expect(await store.remove("tenancy")).toBe(true);
    expect(await store.remove("tenancy")).toBe(false);
    expect(
      await createInstanceSettingsRepository(db).get("tenancy"),
    ).toBeUndefined();
  });

  // #715-T03
  it("keeps a lease for one holder until it runs out and releases it only for the value that holds it", async () => {
    const { db } = await createTestDatabase();
    const store = createInstanceSettingsStore<Domain>(
      db,
      () => new Date("2026-10-26T10:00:00.000Z"),
    );
    const mine = { startedAt: "2026-10-26T10:00:00.000Z" };
    const theirs = { startedAt: "2026-10-26T10:05:00.000Z" };

    const first = await store.claim(
      "billing_destination_lock",
      mine,
      null,
      "2026-10-26T09:59:00.000Z",
    );
    const second = await store.claim(
      "billing_destination_lock",
      theirs,
      null,
      "2026-10-26T09:59:00.000Z",
    );

    expect([first, second]).toEqual([true, false]);
    expect(await store.release("billing_destination_lock", theirs)).toBe(false);
    expect(await store.release("billing_destination_lock", mine)).toBe(true);
  });
});
