// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the app_settings repository against a real SQLite file: reading a setting that was never
// saved, saving and replacing a value with the time and the person, JSON values of every shape, and
// removing a setting.
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { createAppSettingsRepository } from "./app-settings-repository.ts";

describe("the app settings repository", () => {
  it("returns undefined for a setting that was never saved", async () => {
    const { db } = await createTestDatabase();
    const workspaceId = await defaultWorkspaceId(db);

    expect(
      await createAppSettingsRepository(db, workspaceId).get("missing"),
    ).toBeUndefined();
  });

  it("saves a JSON value with the time and the person, and reads it back", async () => {
    const { db } = await createTestDatabase();
    const workspaceId = await defaultWorkspaceId(db);
    const now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createAppSettingsRepository(db, workspaceId, () => now);
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
    const workspaceId = await defaultWorkspaceId(db);
    let now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createAppSettingsRepository(db, workspaceId, () => now);

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
    const workspaceId = await defaultWorkspaceId(db);
    const repository = createAppSettingsRepository(db, workspaceId);

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
    const workspaceId = await defaultWorkspaceId(db);
    const repository = createAppSettingsRepository(db, workspaceId);
    await repository.set("review_defaults", {}, "octocat");

    await repository.delete("review_defaults");
    await repository.delete("review_defaults");

    expect(await repository.get("review_defaults")).toBeUndefined();
  });

  it("refuses a value that JSON cannot hold", async () => {
    const { db } = await createTestDatabase();
    const workspaceId = await defaultWorkspaceId(db);

    await expect(
      createAppSettingsRepository(db, workspaceId).set("x", undefined, null),
    ).rejects.toThrow(/JSON/);
  });
});

describe("a stored value that is not valid JSON", () => {
  it("reads as no value, with a warning that names the setting and not the text", async () => {
    const { db } = await createTestDatabase();
    const workspaceId = await defaultWorkspaceId(db);
    const warn = vi.fn();
    const repository = createAppSettingsRepository(
      db,
      workspaceId,
      undefined,
      warn,
    );
    await repository.set("review_defaults", { a: 1 }, "octocat");
    await sql`update app_settings set value = '{damaged secret-looking-text'`.execute(
      db,
    );

    const stored = await repository.get("review_defaults");

    expect(stored).toMatchObject({ value: undefined, updatedBy: "octocat" });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("APP_SETTING_UNREADABLE");
    expect(line).toContain("review_defaults");
    expect(line).not.toContain("secret-looking-text");
  });

  it("is replaced by the next save", async () => {
    const { db } = await createTestDatabase();
    const workspaceId = await defaultWorkspaceId(db);
    const repository = createAppSettingsRepository(
      db,
      workspaceId,
      undefined,
      () => undefined,
    );
    await repository.set("review_defaults", {}, null);
    await sql`update app_settings set value = 'nope'`.execute(db);

    await repository.set("review_defaults", { a: 2 }, null);

    expect((await repository.get("review_defaults"))?.value).toEqual({ a: 2 });
  });
});

// #676: a save of the workspace defaults over defaults that were saved meanwhile is refused (review fix 4), on both engines.
describe.each([
  { name: "SQLite", database: async () => (await createTestDatabase()).db },
  ...(hasPostgres()
    ? [
        {
          name: "Postgres",
          database: async () => (await createPostgresTestDatabase()).db,
        },
      ]
    : []),
])("saving a setting only while it is unchanged on $name", (engine) => {
  async function start() {
    const db = await engine.database();
    const workspaceId = await defaultWorkspaceId(db);
    let tick = 0;
    const repository = createAppSettingsRepository(
      db,
      workspaceId,
      () => new Date(Date.UTC(2026, 9, 10, 8, 0, tick++)),
    );
    return { db, repository };
  }

  it("writes the first value when the caller read no row, and refuses a second writer that read none", async () => {
    const { repository } = await start();

    expect(await repository.setIfUnchanged("k", { a: 1 }, "ada", null)).toBe(
      true,
    );
    expect(await repository.setIfUnchanged("k", { a: 2 }, "bo", null)).toBe(
      false,
    );

    expect((await repository.get("k"))?.value).toEqual({ a: 1 });
  });

  it("writes over the value the caller read, and refuses a caller whose read is out of date", async () => {
    const { repository } = await start();
    await repository.set("k", { a: 1 }, "ada");
    const read = (await repository.get("k"))?.updatedAt ?? null;
    await repository.set("k", { a: 2 }, "bo");

    expect(await repository.setIfUnchanged("k", { a: 3 }, "ada", read)).toBe(
      false,
    );
    const current = (await repository.get("k"))?.updatedAt ?? null;
    expect(await repository.setIfUnchanged("k", { a: 4 }, "ada", current)).toBe(
      true,
    );

    expect(await repository.get("k")).toMatchObject({
      value: { a: 4 },
      updatedBy: "ada",
    });
  });

  it("lets only one of two saves of the same read win", async () => {
    const { repository } = await start();
    await repository.set("k", { a: 1 }, "ada");
    const read = (await repository.get("k"))?.updatedAt ?? null;

    const results = await Promise.all([
      repository.setIfUnchanged("k", { who: "ada" }, "ada", read),
      repository.setIfUnchanged("k", { who: "bo" }, "bo", read),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rolls the write back when what runs with it fails, and runs it with the write otherwise", async () => {
    const { repository } = await start();
    await repository.set("k", { a: 1 }, "ada");
    const read = (await repository.get("k"))?.updatedAt ?? null;

    await expect(
      repository.setIfUnchanged("k", { a: 2 }, "bo", read, async () => {
        throw new Error("the follow-up failed");
      }),
    ).rejects.toThrow("the follow-up failed");
    expect((await repository.get("k"))?.value).toEqual({ a: 1 });

    let sawWrite: unknown;
    expect(
      await repository.setIfUnchanged(
        "k",
        { a: 3 },
        "bo",
        read,
        async (trx) => {
          sawWrite = (
            await trx
              .selectFrom("app_settings")
              .select("value")
              .where("key", "=", "k")
              .executeTakeFirstOrThrow()
          ).value;
        },
      ),
    ).toBe(true);
    expect(JSON.parse(String(sawWrite))).toEqual({ a: 3 });
  });

  it("runs the follow-up of a plain save in the same transaction and rolls the save back with it", async () => {
    const { repository } = await start();

    await expect(
      repository.set("k", { a: 1 }, "ada", async () => {
        throw new Error("the follow-up failed");
      }),
    ).rejects.toThrow("the follow-up failed");

    expect(await repository.get("k")).toBeUndefined();
  });
});
