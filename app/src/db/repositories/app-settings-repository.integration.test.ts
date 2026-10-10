// Pins down the app_settings repository against a real SQLite file: reading a setting that was never
// saved, saving and replacing a value with the time and the person, JSON values of every shape, and
// removing a setting.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createAppSettingsRepository } from "./app-settings-repository.ts";

describe("the app settings repository", () => {
  it("returns undefined for a setting that was never saved", async () => {
    const { db } = await createTestDatabase();

    expect(
      await createAppSettingsRepository(db).get("missing"),
    ).toBeUndefined();
  });

  it("saves a JSON value with the time and the person, and reads it back", async () => {
    const { db } = await createTestDatabase();
    const now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createAppSettingsRepository(db, () => now);
    const value = { maxFindings: 4, list: ["a", "b"], nested: { on: true } };

    await repository.set("review_defaults", value, "octocat");

    expect(await repository.get("review_defaults")).toEqual({
      value,
      updatedAt: "2026-10-10T08:00:00.000Z",
      updatedBy: "octocat",
    });
  });

  it("replaces the value of an existing setting and moves the time and the person", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createAppSettingsRepository(db, () => now);

    await repository.set("review_defaults", { a: 1 }, "octocat");
    now = new Date("2026-10-10T09:00:00.000Z");
    await repository.set("review_defaults", { b: 2 }, "hubot");

    expect(await repository.get("review_defaults")).toEqual({
      value: { b: 2 },
      updatedAt: "2026-10-10T09:00:00.000Z",
      updatedBy: "hubot",
    });
    const { rows } = await sql`select count(*) as n from app_settings`.execute(
      db,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("keeps settings with different keys apart and allows no person", async () => {
    const { db } = await createTestDatabase();
    const repository = createAppSettingsRepository(db);

    await repository.set("one", 1, null);
    await repository.set("two", "2", "octocat");

    expect(await repository.get("one")).toMatchObject({
      value: 1,
      updatedBy: null,
    });
    expect(await repository.get("two")).toMatchObject({ value: "2" });
  });

  it("removes a setting, and removing one that is not there is fine", async () => {
    const { db } = await createTestDatabase();
    const repository = createAppSettingsRepository(db);
    await repository.set("review_defaults", {}, "octocat");

    await repository.delete("review_defaults");
    await repository.delete("review_defaults");

    expect(await repository.get("review_defaults")).toBeUndefined();
  });

  it("refuses a value that JSON cannot hold", async () => {
    const { db } = await createTestDatabase();

    await expect(
      createAppSettingsRepository(db).set("x", undefined, null),
    ).rejects.toThrow(/JSON/);
  });
});
