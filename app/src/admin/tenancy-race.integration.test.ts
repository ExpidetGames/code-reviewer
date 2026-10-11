// Pins down the race the switch to single-tenant has with the creation of a workspace: two real
// processes, each with its own connection to one database file, start together. However they
// interleave, the instance never ends up single-tenant with two workspaces; one of the two is refused
// because it saw the result of the other. (A lock held in the test's own process could not be
// released while a write waits for it, so the two sides are processes, see TESTING.md.)
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { startDbProcess } from "../test-support/db-process.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

type RaceResult = { ok: boolean; error?: string; count?: number };

async function race(round: number) {
  const { db, config } = await createTestDatabase();
  for (const id of ["admin-1", "user-1"])
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${id}, ${`${id}@example.test`}, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  await createInstanceSettingsRepository(db).set("tenancy", "multi", null);
  // One workspace exists already, so the switch to single is allowed on its own.
  await createWorkspacesRepository(db).create({
    name: "Existing",
    slug: "existing",
    createdBy: "user-1",
  });

  const switcher = startDbProcess([
    "set-tenancy",
    config.path,
    "admin-1",
    "single",
  ]);
  const creator = startDbProcess([
    "create-workspace",
    config.path,
    "user-1",
    `new-${round}`,
  ]);
  expect(await switcher.nextLine()).toBe("ready");
  expect(await creator.nextLine()).toBe("ready");
  const startAt = Date.now() + 300;
  switcher.send(`go ${startAt}`);
  creator.send(`go ${startAt}`);
  const switched = JSON.parse(await switcher.nextLine()) as RaceResult;
  const created = JSON.parse(await creator.nextLine()) as RaceResult;
  await switcher.exited;
  await creator.exited;

  const tenancy = await createInstanceSettingsRepository(db).get("tenancy");
  const workspaceCount = Number(
    (
      await db
        .selectFrom("workspaces")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow()
    ).count,
  );
  return { switched, created, tenancy, workspaceCount };
}

describe("switching to single-tenant while a workspace is being created", () => {
  // #98-AD-08
  it("never leaves a single-tenant instance with two workspaces, and one side sees the result of the other", async () => {
    const outcomes = new Set<string>();

    for (let round = 0; round < 6; round += 1) {
      const result = await race(round);

      expect(result.tenancy === "single" && result.workspaceCount > 1).toBe(
        false,
      );
      if (result.switched.ok) {
        // The switch came first: the instance is single-tenant, and the creation was refused.
        expect(result.tenancy).toBe("single");
        expect(result.created).toEqual({
          ok: false,
          error: "tenancy_is_single",
        });
        expect(result.workspaceCount).toBe(1);
        outcomes.add("switch first");
      } else {
        // The workspace came first: now there are two, so the switch was refused.
        expect(result.switched).toEqual({
          ok: false,
          error: "too_many_workspaces",
          count: 2,
        });
        expect(result.created.ok).toBe(true);
        expect(result.tenancy).toBe("multi");
        expect(result.workspaceCount).toBe(2);
        outcomes.add("workspace first");
      }
    }

    expect(outcomes.size).toBeGreaterThan(0);
  });
});
