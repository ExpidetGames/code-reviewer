// The workspaces table: the default workspace is made once, however many requests ask for it at the
// same time, and the oldest workspace is the default.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createWorkspacesRepository } from "./workspaces-repository.ts";

describe("the workspaces repository", () => {
  it("has no workspace in a fresh database", async () => {
    const { db } = await createTestDatabase();

    expect(await createWorkspacesRepository(db).findDefault()).toBeUndefined();
  });

  it("makes the default workspace on first use and returns the same one afterwards", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);

    const first = await repository.ensureDefault();
    const second = await repository.ensureDefault();

    expect(first).toMatchObject({ name: "Default workspace", slug: "default" });
    expect(second).toEqual(first);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  it("makes one default workspace when several requests ask at once", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);

    const ids = await Promise.all(
      Array.from(
        { length: 5 },
        async () => (await repository.ensureDefault()).id,
      ),
    );

    expect(new Set(ids).size).toBe(1);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  it("calls the oldest workspace the default one", async () => {
    const { db } = await createTestDatabase();
    let tick = 0;
    const repository = createWorkspacesRepository(
      db,
      () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++)),
    );
    const older = await repository.create({
      name: "First",
      slug: "first",
      createdBy: null,
    });
    await repository.create({
      name: "Second",
      slug: "second",
      createdBy: null,
    });

    expect((await repository.findDefault())?.id).toBe(older.id);
    expect((await repository.ensureDefault()).id).toBe(older.id);
  });
});
