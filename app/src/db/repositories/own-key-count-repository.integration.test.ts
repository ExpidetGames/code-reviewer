// SPDX-License-Identifier: Apache-2.0

// How many workspaces hold a stored own LLM key of any provider: the number the instance admin reads before switching
// billing on (#504). It counts workspaces, not keys, and returns a number only.
import { describe, expect, it } from "vitest";
import { WORKSPACE_SECRET_NAMES } from "../../secrets/names.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import type { Database } from "../schema.ts";
import type { Kysely } from "kysely";
import { createOwnKeyCountRepository } from "./own-key-count-repository.ts";
import { createWorkspacesRepository } from "./workspaces-repository.ts";

async function addKey(
  db: Kysely<Database>,
  workspaceId: string,
  name: string,
): Promise<void> {
  await db
    .insertInto("workspace_secrets")
    .values({
      workspace_id: workspaceId,
      name,
      binding: "provider",
      ciphertext: "c",
      nonce: "n",
      key_version: 1,
      last_four: null,
      updated_by: null,
      updated_at: "2026-10-20T10:00:00.000Z",
    })
    .execute();
}

describe("the count of workspaces with a stored own key", () => {
  // #504-T13
  it("is zero when no workspace holds one", async () => {
    const { db } = await createTestDatabase();

    expect(
      await createOwnKeyCountRepository(db).countWorkspacesWithStoredOwnKey(),
    ).toBe(0);
  });

  // #504-T13
  it("counts a workspace once, however many providers it holds a key for, and no workspace without one", async () => {
    const { db } = await createTestDatabase();
    const workspaces = createWorkspacesRepository(db);
    const names = [...WORKSPACE_SECRET_NAMES];
    expect(names.length).toBeGreaterThan(1);
    const a = await workspaces.create({
      name: "A",
      slug: "a",
      createdBy: null,
    });
    const b = await workspaces.create({
      name: "B",
      slug: "b",
      createdBy: null,
    });
    await workspaces.create({ name: "C", slug: "c", createdBy: null });
    for (const name of names) await addKey(db, a.id, name);
    await addKey(db, b.id, names[0] ?? "");

    expect(
      await createOwnKeyCountRepository(db).countWorkspacesWithStoredOwnKey(),
    ).toBe(2);
  });
});
