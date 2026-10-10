// Pins down what the server start does with the database: it migrates and keeps the connection, and
// a database problem ends the start with one readable line and exit code 1.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDirectory } from "../test-support/test-database.ts";
import { createAppMetaRepository } from "./repositories/app-meta-repository.ts";
import { closeDatabase, getDatabase, initializeDatabaseOnStart } from "./startup.ts";

afterEach(closeDatabase);

describe("initializeDatabaseOnStart", () => {
  // CR-15-T01
  it("creates the file at DATABASE_PATH, migrates it and keeps the connection for the app", async () => {
    const directory = await createTestDirectory();
    const exit = vi.fn();

    await initializeDatabaseOnStart({ env: { DATABASE_PATH: join(directory, "app.db") }, exit });

    const repository = createAppMetaRepository(getDatabase());
    await repository.set("started", "yes");
    expect(await repository.get("started")).toBe("yes");
    expect(exit).not.toHaveBeenCalled();
  });

  // CR-15-T10
  it("ends the start with one readable line naming the path when the directory is missing", async () => {
    const directory = await createTestDirectory();
    const missing = join(directory, "not-created");
    const log = vi.fn();
    const exit = vi.fn();

    await initializeDatabaseOnStart({ env: { DATABASE_PATH: join(missing, "app.db") }, log, exit });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DATABASE_DIRECTORY_UNAVAILABLE");
    expect(line).toContain(missing);
    expect(line).not.toContain("\n    at ");
  });

  it("refuses to hand out a connection when the start did not open the database", () => {
    expect(() => getDatabase()).toThrow(/not initialized/);
  });
});
