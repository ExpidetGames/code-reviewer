// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the change of the tenancy against a real SQLite file (docs/decisions/0001-editions-setup-
// and-accounts.md, section 2.3): single to multi is always allowed; multi to single only while at most
// one workspace exists, and with none the default workspace is created and the acting admin becomes
// its Owner. Whatever is refused changes nothing. The race with a workspace being created at the same
// moment is in tenancy-race.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { markWorkspaceDeleted } from "../test-support/workspaces.ts";
import { changeTenancy } from "./tenancy.ts";

async function startInstance(tenancy: "single" | "multi") {
  const { db } = await createTestDatabase();
  for (const id of ["admin-1", "user-2"])
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${id}, ${`${id}@example.test`}, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  const settings = createInstanceSettingsRepository(db);
  await settings.set("tenancy", tenancy, null);
  const workspaces = createWorkspacesRepository(db);
  const members = () =>
    sql<{
      workspace_id: string;
      user_id: string;
      role: string;
    }>`select workspace_id, user_id, role from workspace_members order by user_id`
      .execute(db)
      .then((result) => result.rows);
  const count = () =>
    db
      .selectFrom("workspaces")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((row) => Number(row.count));
  return { db, settings, workspaces, members, count };
}

describe("changing the tenancy from multi to single", () => {
  // #98-AD-04
  it("creates the default workspace with the acting admin as its Owner when there is none", async () => {
    const { db, settings, members, count } = await startInstance("multi");

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(await settings.get("tenancy")).toBe("single");
    expect(await count()).toBe(1);
    const workspace = await createWorkspacesRepository(db).findDefault();
    expect(workspace).toMatchObject({
      name: "Default workspace",
      slug: "default",
      createdBy: "admin-1",
    });
    expect(await members()).toEqual([
      { workspace_id: workspace?.id, user_id: "admin-1", role: "owner" },
    ]);
  });

  // #98-AD-05
  it("leaves the one workspace that exists as it is", async () => {
    const { db, settings, workspaces, members, count } =
      await startInstance("multi");
    const existing = await workspaces.create({
      name: "Team A",
      slug: "team-a",
      createdBy: "user-2",
    });
    await workspaces.addMember(existing.id, "user-2", "owner");

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(await settings.get("tenancy")).toBe("single");
    expect(await count()).toBe(1);
    expect(await workspaces.get(existing.id)).toEqual(existing);
    expect(await members()).toEqual([
      { workspace_id: existing.id, user_id: "user-2", role: "owner" },
    ]);
  });

  // #98-AD-06
  it("is refused with the number of workspaces when there are two, and changes nothing", async () => {
    const { db, settings, workspaces, members, count } =
      await startInstance("multi");
    await workspaces.create({ name: "A", slug: "a", createdBy: "user-2" });
    await workspaces.create({ name: "B", slug: "b", createdBy: "user-2" });
    await workspaces.create({ name: "C", slug: "c", createdBy: "user-2" });

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({
      ok: false,
      error: "too_many_workspaces",
      count: 3,
    });
    expect(await settings.get("tenancy")).toBe("multi");
    expect(await count()).toBe(3);
    expect(await members()).toEqual([]);
    expect(
      await settings.getWithMeta("tenancy").then((meta) => meta?.updatedBy),
    ).toBeNull();
  });
});

describe("changing the tenancy from multi to single with deleted workspaces", () => {
  // #658-T03
  it("does not count a deleted workspace: one live workspace and a tombstone is allowed and keeps the live one", async () => {
    const { db, settings, workspaces } = await startInstance("multi");
    const live = await workspaces.create({
      name: "Team A",
      slug: "team-a",
      createdBy: "user-2",
    });
    const gone = await workspaces.create({
      name: "Team B",
      slug: "team-b",
      createdBy: "user-2",
    });
    await markWorkspaceDeleted(db, gone.id);

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(await settings.get("tenancy")).toBe("single");
    expect(await workspaces.count()).toBe(1);
    expect((await workspaces.findDefault())?.id).toBe(live.id);
  });

  // #658-T03
  it("reports the number of live workspaces when it refuses, not the tombstones", async () => {
    const { db, workspaces } = await startInstance("multi");
    for (const slug of ["a", "b"])
      await workspaces.create({ name: slug, slug, createdBy: "user-2" });
    const gone = await workspaces.create({
      name: "C",
      slug: "c",
      createdBy: "user-2",
    });
    await markWorkspaceDeleted(db, gone.id);

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({
      ok: false,
      error: "too_many_workspaces",
      count: 2,
    });
  });

  // #658-T03
  it("creates the Default workspace when only tombstones are left, with the acting admin as its Owner", async () => {
    const { db, settings, workspaces, members } = await startInstance("multi");
    const gone = await workspaces.create({
      name: "Team B",
      slug: "default",
      createdBy: "user-2",
    });
    await markWorkspaceDeleted(db, gone.id);

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(await settings.get("tenancy")).toBe("single");
    expect(await workspaces.count()).toBe(1);
    const created = await workspaces.findDefault();
    expect(created).toMatchObject({
      name: "Default workspace",
      slug: "default",
      createdBy: "admin-1",
    });
    expect(created?.id).not.toBe(gone.id);
    expect(await members()).toEqual([
      { workspace_id: created?.id, user_id: "admin-1", role: "owner" },
    ]);
  });
});

describe("changing the tenancy from single to multi", () => {
  // #98-AD-07
  it("is allowed and leaves the workspace and its members as they are", async () => {
    const { db, settings, workspaces, members, count } =
      await startInstance("single");
    const workspace = await workspaces.create({
      name: "Default workspace",
      slug: "default",
      createdBy: "admin-1",
    });
    await workspaces.addMember(workspace.id, "admin-1", "owner");
    await workspaces.addMember(workspace.id, "user-2", "member");

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "multi",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(await settings.get("tenancy")).toBe("multi");
    expect(await count()).toBe(1);
    expect(await members()).toEqual([
      { workspace_id: workspace.id, user_id: "admin-1", role: "owner" },
      { workspace_id: workspace.id, user_id: "user-2", role: "member" },
    ]);
  });
});

describe("a change to the tenancy it already has", () => {
  it("changes nothing and does not touch who changed it last", async () => {
    const { db, settings } = await startInstance("single");

    const result = await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "single",
    });

    expect(result).toEqual({ ok: true, changed: false });
    expect(
      await settings.getWithMeta("tenancy").then((meta) => meta?.updatedBy),
    ).toBeNull();
  });
});

describe("recording the change", () => {
  // #98-AD-14
  it("stores who changed the tenancy and when", async () => {
    const { db, settings } = await startInstance("single");

    await changeTenancy(db, {
      actorId: "admin-1",
      tenancy: "multi",
      now: () => new Date("2026-10-11T10:15:00.000Z"),
    });

    expect(await settings.getWithMeta("tenancy")).toEqual({
      value: "multi",
      updatedBy: "admin-1",
      updatedAt: "2026-10-11T10:15:00.000Z",
    });
  });
});
