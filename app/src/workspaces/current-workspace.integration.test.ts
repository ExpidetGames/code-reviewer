// SPDX-License-Identifier: Apache-2.0

// Pins down which workspace the temporary resolver hands out: the existing default one, none and an
// error while the first-run setup has not run (the setup decides whether there is a workspace), and
// the lazily made default workspace once the instance is set up.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  resolveCurrentWorkspaceId,
  WorkspaceUnavailableError,
} from "./current-workspace.ts";

describe("the current workspace", () => {
  // #97-SU-12
  it("creates no workspace on a fresh instance that is not set up, and says so", async () => {
    const { db } = await createTestDatabase();

    await expect(resolveCurrentWorkspaceId(db)).rejects.toBeInstanceOf(
      WorkspaceUnavailableError,
    );

    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
  });

  // #97-SU-22
  it("keeps the imported workspace of an existing installation that is not set up yet", async () => {
    const { db } = await createTestDatabase();
    const imported = await createWorkspacesRepository(db).create({
      name: "Default workspace",
      slug: "default",
      createdBy: null,
    });

    expect(await resolveCurrentWorkspaceId(db)).toBe(imported.id);
  });

  it("makes the default workspace on first use once the instance is set up and has none", async () => {
    const { db } = await createTestDatabase();
    await createInstanceSettingsRepository(db).set(
      "setup_completed_at",
      "2026-10-11T08:00:00.000Z",
      null,
    );

    const first = await resolveCurrentWorkspaceId(db);
    const second = await resolveCurrentWorkspaceId(db);

    expect(second).toBe(first);
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual([
      { id: first },
    ]);
  });

  it("does not treat a stored null marker as set up", async () => {
    const { db } = await createTestDatabase();
    await createInstanceSettingsRepository(db).set(
      "setup_completed_at",
      null,
      null,
    );

    await expect(resolveCurrentWorkspaceId(db)).rejects.toBeInstanceOf(
      WorkspaceUnavailableError,
    );
  });
});
