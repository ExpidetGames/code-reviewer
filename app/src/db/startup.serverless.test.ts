// SPDX-License-Identifier: LicenseRef-Proprietary

// The lazy database of serverless mode (#319): nothing is opened at start, the first `getDatabase()`
// opens the Postgres pool (which itself connects on the first query), later calls share it, and the
// SQLite driver is never loaded on that path. Server mode keeps its rule: the database is opened by the
// start, and asking before that fails loudly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqliteLoaded = vi.hoisted(() => ({ value: false }));
vi.mock("better-sqlite3", () => {
  sqliteLoaded.value = true;
  return { default: class {} };
});

import { DatabaseError } from "./errors.ts";
import { closeDatabase, getDatabase } from "./startup.ts";

beforeEach(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
});

describe("getDatabase in serverless mode", () => {
  // #319-T05
  it("opens the database on the first call and shares it afterwards, without connecting", () => {
    vi.stubEnv("APP_RUNTIME", "serverless");
    // Nothing listens on port 1: a connection attempt would show up as a failure of the next test.
    vi.stubEnv("DATABASE_URL", "postgres://app:pw@127.0.0.1:1/app");

    const first = getDatabase();
    const second = getDatabase();

    expect(second).toBe(first);
  });

  // #319-T05
  it("loads no SQLite driver on the way", () => {
    vi.stubEnv("APP_RUNTIME", "serverless");
    vi.stubEnv("DATABASE_URL", "postgres://app:pw@127.0.0.1:1/app");

    getDatabase();

    expect(sqliteLoaded.value).toBe(false);
  });

  // #319-T05
  it("opens a new database after the old one was closed", async () => {
    vi.stubEnv("APP_RUNTIME", "serverless");
    vi.stubEnv("DATABASE_URL", "postgres://app:pw@127.0.0.1:1/app");
    const first = getDatabase();

    await closeDatabase();

    expect(getDatabase()).not.toBe(first);
  });

  // #319-T04
  it("refuses SQLite with the stable code, on the first call and not at import", () => {
    vi.stubEnv("APP_RUNTIME", "serverless");
    vi.stubEnv("DATABASE_URL", "sqlite:///data/secret-name.db");

    let caught: unknown;
    try {
      getDatabase();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseError);
    expect((caught as DatabaseError).code).toBe(
      "DATABASE_SERVERLESS_NEEDS_POSTGRES",
    );
    expect((caught as DatabaseError).message).not.toContain("secret-name");
  });
});

describe("getDatabase in server mode", () => {
  // #319-T06
  it("still fails loudly when the server did not open the database", () => {
    vi.stubEnv("APP_RUNTIME", "server");
    vi.stubEnv("DATABASE_URL", "postgres://app:pw@127.0.0.1:1/app");

    expect(() => getDatabase()).toThrow(/not initialized/);
  });
});
