// SPDX-License-Identifier: Apache-2.0

// Pins down the app_meta repository against a real SQLite file: reading a missing key, writing,
// and replacing a value while moving the timestamp.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createAppMetaRepository } from "./app-meta-repository.ts";

describe("the app meta repository", () => {
  it("returns undefined for a key that was never set", async () => {
    const { db } = await createTestDatabase();

    expect(await createAppMetaRepository(db).get("missing")).toBeUndefined();
  });

  it("replaces the value of an existing key and records when it changed", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createAppMetaRepository(db, () => now);

    await repository.set("greeting", "hello");
    now = new Date("2026-10-10T09:00:00.000Z");
    await repository.set("greeting", "hi");

    expect(await repository.get("greeting")).toBe("hi");
    const { rows } =
      await sql`select key, value, updated_at from app_meta`.execute(db);
    expect(rows).toEqual([
      { key: "greeting", value: "hi", updated_at: "2026-10-10T09:00:00.000Z" },
    ]);
  });
});
