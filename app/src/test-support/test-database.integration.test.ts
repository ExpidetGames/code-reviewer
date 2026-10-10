// Pins down the database helper the integration tests stand on: each test gets its own migrated
// copy of the template, copies share nothing, and nothing is left on disk afterwards.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import { cleanUpTestResources, createTestDatabase } from "./test-database.ts";

describe("createTestDatabase", () => {
  // CR-15-T13
  it("gives every caller its own migrated file that shares no data with another", async () => {
    const first = await createTestDatabase();
    const second = await createTestDatabase();

    await createAppMetaRepository(first.db).set("only-in-first", "yes");

    expect(first.config.path).not.toBe(second.config.path);
    expect(await createAppMetaRepository(first.db).get("only-in-first")).toBe(
      "yes",
    );
    expect(
      await createAppMetaRepository(second.db).get("only-in-first"),
    ).toBeUndefined();
  });

  // CR-15-T13
  it("removes the file, its directory and the connection when the test is cleaned up", async () => {
    const { config, directory } = await createTestDatabase();
    expect(existsSync(config.path)).toBe(true);

    await cleanUpTestResources();

    expect(existsSync(directory)).toBe(false);
  });
});
