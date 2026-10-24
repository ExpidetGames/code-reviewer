// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the setup state is read from the two explicit markers and from whether users exist,
// against a real SQLite file: a database from before the markers, the combinations of the existing
// installation, and a completed setup. The state is never inferred from whether a row exists.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSetupStateReader, readSetupState } from "./state.ts";

async function addUser(
  db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
) {
  await db
    .insertInto("users")
    .values({
      id: "u1",
      name: "u1",
      email: "u1@example.test",
      email_verified: 0,
      image: null,
      github_login: "u1",
      imported_at: null,
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-11T00:00:00.000Z",
      updated_at: "2026-10-11T00:00:00.000Z",
    })
    .execute();
}

describe("the setup state", () => {
  // #97-SU-03
  it("is fresh for a database from before the markers, with no users", async () => {
    const { db } = await createTestDatabase();

    expect(await readSetupState(db)).toEqual({ kind: "fresh" });
  });

  // #97-SU-22
  it("is an existing installation when users exist and the setup was not completed, whatever the import state", async () => {
    const { db } = await createTestDatabase();
    await addUser(db);
    expect(await readSetupState(db)).toEqual({ kind: "existing" });

    const settings = createInstanceSettingsRepository(db);
    await settings.set("import_state", "none", null);
    expect(await readSetupState(db)).toEqual({ kind: "existing" });
    await settings.set("import_state", "done", null);
    expect(await readSetupState(db)).toEqual({ kind: "existing" });
  });

  it("is an existing installation when the import ran, even without users", async () => {
    const { db } = await createTestDatabase();
    await createInstanceSettingsRepository(db).set(
      "import_state",
      "done",
      null,
    );

    expect(await readSetupState(db)).toEqual({ kind: "existing" });
  });

  it("is completed once setup_completed_at has a value, and a null value is not completed", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);
    await settings.set("setup_completed_at", null, null);
    expect(await readSetupState(db)).toEqual({ kind: "fresh" });

    await settings.set("setup_completed_at", "2026-10-11T08:00:00.000Z", null);
    await addUser(db);

    expect(await readSetupState(db)).toEqual({ kind: "completed" });
  });

  it("stays completed for the life of the reader without asking the database again", async () => {
    let reads = 0;
    const read = createSetupStateReader(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { kind: "completed" as const }
          : { kind: "fresh" as const },
      );
    });

    expect(await read()).toEqual({ kind: "completed" });
    expect(await read()).toEqual({ kind: "completed" });
    expect(reads).toBe(1);
  });

  it("keeps asking the database while the setup is open", async () => {
    let reads = 0;
    const read = createSetupStateReader(() => {
      reads += 1;
      return Promise.resolve({ kind: "fresh" as const });
    });

    await read();
    await read();

    expect(reads).toBe(2);
  });
});
