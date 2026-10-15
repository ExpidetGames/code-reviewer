// SPDX-License-Identifier: Apache-2.0

// Pins down the database settings in serverless mode (#319): Postgres only, a small pool with a short
// idle timeout, and the separate direct URL of the migration command. A refused value never repeats a
// URL: it carries the password.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_MAX,
  loadDatabaseConfig,
  loadMigrationDatabaseConfig,
  SERVERLESS_DEFAULT_POOL_MAX,
  SERVERLESS_MAX_POOL_MAX,
  SERVERLESS_POOL_IDLE_TIMEOUT_MS,
} from "./config.ts";
import { DatabaseError } from "./errors.ts";

const URL_WITH_PASSWORD = "postgres://app:s3cr3t-pw@db.example.test:5432/app";
const serverless = { APP_RUNTIME: "serverless" } as const;

function failureOf(load: () => unknown): DatabaseError {
  try {
    load();
  } catch (error) {
    if (error instanceof DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the settings to be refused");
}

describe("loadDatabaseConfig in serverless mode", () => {
  // #319-T07
  it("uses a pool of 3 with a short idle timeout and the platform pool hook by default", () => {
    expect(SERVERLESS_DEFAULT_POOL_MAX).toBe(3);
    expect(
      loadDatabaseConfig({ ...serverless, DATABASE_URL: URL_WITH_PASSWORD }),
    ).toEqual({
      driver: "postgres",
      url: URL_WITH_PASSWORD,
      poolMax: 3,
      idleTimeoutMs: SERVERLESS_POOL_IDLE_TIMEOUT_MS,
      attachPlatformPool: true,
    });
    expect(SERVERLESS_POOL_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  // #319-T07
  it("takes DATABASE_POOL_MAX up to the serverless limit and refuses more", () => {
    const env = { ...serverless, DATABASE_URL: URL_WITH_PASSWORD };
    expect(
      loadDatabaseConfig({ ...env, DATABASE_POOL_MAX: "1" }),
    ).toMatchObject({ poolMax: 1 });
    expect(
      loadDatabaseConfig({
        ...env,
        DATABASE_POOL_MAX: String(SERVERLESS_MAX_POOL_MAX),
      }),
    ).toMatchObject({ poolMax: SERVERLESS_MAX_POOL_MAX });
    for (const value of ["0", String(SERVERLESS_MAX_POOL_MAX + 1), "abc"]) {
      const error = failureOf(() =>
        loadDatabaseConfig({ ...env, DATABASE_POOL_MAX: value }),
      );
      expect(error.code).toBe("DATABASE_CONFIG_INVALID");
      expect(error.message).toContain("DATABASE_POOL_MAX");
      expect(error.message).not.toContain("s3cr3t-pw");
    }
  });

  // #319-T07
  it("is selected by the platform marker as well", () => {
    expect(
      loadDatabaseConfig({ VERCEL: "1", DATABASE_URL: URL_WITH_PASSWORD }),
    ).toMatchObject({ poolMax: 3, attachPlatformPool: true });
  });

  // #319-T06
  it("keeps the server defaults and adds nothing to them", () => {
    const config = loadDatabaseConfig({ DATABASE_URL: URL_WITH_PASSWORD });
    expect(config).toEqual({
      driver: "postgres",
      url: URL_WITH_PASSWORD,
      poolMax: DEFAULT_POOL_MAX,
    });
    expect(
      loadDatabaseConfig({
        APP_RUNTIME: "server",
        VERCEL: "1",
        DATABASE_URL: URL_WITH_PASSWORD,
      }),
    ).toEqual(config);
  });

  // #319-T04
  it.each([
    ["nothing", {}],
    ["a path", { DATABASE_URL: "/data/app.db" }],
    ["a sqlite: URL", { DATABASE_URL: "sqlite:///data/secret-name.db" }],
    ["DATABASE_PATH", { DATABASE_PATH: "/data/secret-name.db" }],
  ])(
    "refuses SQLite (%s) with a clear message that names no value",
    (_, env) => {
      const error = failureOf(() =>
        loadDatabaseConfig({ ...serverless, ...env }),
      );

      expect(error.code).toBe("DATABASE_SERVERLESS_NEEDS_POSTGRES");
      expect(error.message).toContain("DATABASE_URL");
      expect(error.message).toContain("Postgres");
      expect(error.message).not.toContain("secret-name");
      expect(error.message).not.toContain("/data");
    },
  );
});

describe("loadMigrationDatabaseConfig", () => {
  // #319-T03
  it("reads the direct URL from DATABASE_URL_MIGRATE and ignores DATABASE_URL", () => {
    const config = loadMigrationDatabaseConfig({
      DATABASE_URL_MIGRATE: URL_WITH_PASSWORD,
      DATABASE_URL: "postgres://pooled.example.test/app",
    });

    expect(config).toMatchObject({
      driver: "postgres",
      url: URL_WITH_PASSWORD,
    });
    expect(config.poolMax).toBeLessThanOrEqual(2);
  });

  // #319-T03
  it("refuses a missing or non-Postgres URL without repeating it", () => {
    const missing = failureOf(() =>
      loadMigrationDatabaseConfig({ DATABASE_URL: URL_WITH_PASSWORD }),
    );
    expect(missing.code).toBe("DATABASE_CONFIG_INVALID");
    expect(missing.message).toContain("DATABASE_URL_MIGRATE");
    expect(missing.message).not.toContain("s3cr3t-pw");

    const sqlite = failureOf(() =>
      loadMigrationDatabaseConfig({
        DATABASE_URL_MIGRATE: "sqlite:///data/secret-name.db",
      }),
    );
    expect(sqlite.code).toBe("DATABASE_CONFIG_INVALID");
    expect(sqlite.message).toContain("DATABASE_URL_MIGRATE");
    expect(sqlite.message).not.toContain("secret-name");
  });
});
