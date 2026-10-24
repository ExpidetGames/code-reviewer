// SPDX-License-Identifier: LicenseRef-Proprietary

// The statements that end or change an invitation, against a real SQLite file: each one only touches an
// invitation that is still open, and accepting only one that has not expired, so a rule broken in the code
// around them (a race, a missed check) cannot use up, revive or take over an invitation.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import { createInvitationDirectory } from "./invitation-directory-repository.ts";
import { createInvitationsRepository } from "./invitations-repository.ts";

const T0 = Date.parse("2026-10-12T08:00:00.000Z");

async function setup() {
  const { db } = await createTestDatabase();
  const clock = { time: T0 };
  const now = () => new Date(clock.time);
  await db
    .insertInto("users")
    .values({
      id: "u1",
      name: "u1",
      email: "u1@example.test",
      email_verified: 1,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: new Date(T0).toISOString(),
      updated_at: new Date(T0).toISOString(),
    })
    .execute();
  const workspaceId = await defaultWorkspaceId(db);
  const repository = createInvitationsRepository(db, workspaceId, now);
  const invitation = await repository.create({
    id: "inv-1",
    email: "p@example.test",
    role: "member",
    invitedBy: "u1",
    tokenHash: "hash-1",
    expiresAt: new Date(T0 + 60_000),
  });
  return { db, clock, now, workspaceId, repository, invitation };
}

describe("accepting an invitation in one statement", () => {
  // #101-WM-18
  it("uses it up once", async () => {
    const { repository } = await setup();

    expect(await repository.markAccepted("inv-1", "u1")).toBe(true);
    expect(await repository.markAccepted("inv-1", "u1")).toBe(false);
  });

  // #101-WM-16
  it("refuses an invitation at the moment it expires, and not a moment before", async () => {
    const { repository, clock } = await setup();
    clock.time = T0 + 60_000;

    expect(await repository.markAccepted("inv-1", "u1")).toBe(false);
  });

  it("works one millisecond before it expires", async () => {
    const { repository, clock } = await setup();
    clock.time = T0 + 59_999;

    expect(await repository.markAccepted("inv-1", "u1")).toBe(true);
  });

  // #101-WM-17
  it("refuses a revoked invitation", async () => {
    const { repository } = await setup();
    await repository.revoke("inv-1");

    expect(await repository.markAccepted("inv-1", "u1")).toBe(false);
  });
});

describe("ending and renewing an invitation", () => {
  it("does not revoke, or give a new token to, an invitation that was accepted or revoked", async () => {
    const { repository } = await setup();
    await repository.markAccepted("inv-1", "u1");

    expect(await repository.revoke("inv-1")).toBe(false);
    expect(
      await repository.replaceToken("inv-1", "hash-2", new Date(T0 + 120_000)),
    ).toBe(false);
    expect((await repository.get("inv-1"))?.revokedAt).toBeNull();
  });

  // #101-WM-15
  it("replaces the token of an open invitation, which is what stops the old link", async () => {
    const { db, repository } = await setup();
    const directory = createInvitationDirectory(db);

    expect(
      await repository.replaceToken("inv-1", "hash-2", new Date(T0 + 120_000)),
    ).toBe(true);

    expect(await directory.findByTokenHash("hash-1")).toBeUndefined();
    expect((await directory.findByTokenHash("hash-2"))?.id).toBe("inv-1");
  });

  // #101-WM-15
  it("holds at most one open invitation per address and workspace, whatever the code does", async () => {
    const { repository } = await setup();

    await expect(
      repository.create({
        id: "inv-2",
        email: "p@example.test",
        role: "admin",
        invitedBy: "u1",
        tokenHash: "hash-other",
        expiresAt: new Date(T0 + 60_000),
      }),
    ).rejects.toThrow();
    await repository.revoke("inv-1");
    await expect(
      repository.create({
        id: "inv-2",
        email: "p@example.test",
        role: "admin",
        invitedBy: "u1",
        tokenHash: "hash-other",
        expiresAt: new Date(T0 + 60_000),
      }),
    ).resolves.toMatchObject({ id: "inv-2" });
  });

  it("allows the same address in two workspaces", async () => {
    const { db, now } = await setup();
    const otherId = await addWorkspace(db, "other");

    await expect(
      createInvitationsRepository(db, otherId, now).create({
        id: "inv-x",
        email: "p@example.test",
        role: "member",
        invitedBy: "u1",
        tokenHash: "hash-x",
        expiresAt: new Date(T0 + 60_000),
      }),
    ).resolves.toMatchObject({ workspaceId: otherId });
  });

  it("refuses a token hash that another invitation has", async () => {
    const { db, now } = await setup();
    const otherId = await addWorkspace(db, "other");

    await expect(
      createInvitationsRepository(db, otherId, now).create({
        id: "inv-x",
        email: "q@example.test",
        role: "member",
        invitedBy: "u1",
        tokenHash: "hash-1",
        expiresAt: new Date(T0 + 60_000),
      }),
    ).rejects.toThrow();
  });

  it("refuses a role that does not exist, in the database itself", async () => {
    const { db, workspaceId } = await setup();

    await expect(
      db
        .insertInto("invitations")
        .values({
          id: "bad",
          workspace_id: workspaceId,
          email: "z@example.test",
          role: "root",
          token_hash: "h",
          invited_by: null,
          created_at: new Date(T0).toISOString(),
          expires_at: new Date(T0).toISOString(),
          accepted_at: null,
          accepted_by: null,
          revoked_at: null,
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe("the directory of invitations", () => {
  it("lists the open invitations of an address across workspaces, without the expired and the ended", async () => {
    const { db, now, repository, clock } = await setup();
    const otherId = await addWorkspace(db, "other");
    const other = createInvitationsRepository(db, otherId, now);
    await other.create({
      id: "inv-o",
      email: "p@example.test",
      role: "admin",
      invitedBy: "u1",
      tokenHash: "hash-o",
      expiresAt: new Date(T0 + 3_600_000),
    });
    const directory = createInvitationDirectory(db, now);

    expect(
      (await directory.listOpenForEmail("p@example.test"))
        .map((i) => i.id)
        .sort(),
    ).toEqual(["inv-1", "inv-o"]);
    clock.time = T0 + 120_000;
    expect(
      (await directory.listOpenForEmail("p@example.test")).map((i) => i.id),
    ).toEqual(["inv-o"]);
    await other.revoke("inv-o");
    expect(await directory.listOpenForEmail("p@example.test")).toEqual([]);
    expect(await repository.get("inv-1")).toBeDefined();
  });
});
