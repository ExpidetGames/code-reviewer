// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the database settings are read from the environment: the database URL (SQLite or
// Postgres), the SQLite defaults and overrides, the pool size, and the refusal of values that
// cannot be used. A refused value never repeats the password of a Postgres URL.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_DATABASE_PATH,
  DEFAULT_POOL_MAX,
  loadDatabaseConfig,
} from "./config.ts";
import { DatabaseError } from "./errors.ts";

describe("loadDatabaseConfig: SQLite", () => {
  it("uses /data/app.db and a 5000 ms busy timeout when nothing is configured", () => {
    expect(loadDatabaseConfig({})).toEqual({
      driver: "sqlite",
      path: "/data/app.db",
      busyTimeoutMs: 5000,
    });
    expect(DEFAULT_DATABASE_PATH).toBe("/data/app.db");
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000);
  });

  // #105-PG-01
  it("keeps DATABASE_PATH working for existing installations", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_PATH: "/tmp/other.db",
        DATABASE_BUSY_TIMEOUT_MS: "250",
      }),
    ).toEqual({
      driver: "sqlite",
      path: "/tmp/other.db",
      busyTimeoutMs: 250,
    });
  });

  it("treats an empty database path as not configured", () => {
    expect(loadDatabaseConfig({ DATABASE_PATH: "  " })).toMatchObject({
      driver: "sqlite",
      path: "/data/app.db",
    });
  });

  // #105-PG-01
  it.each([
    ["an empty value", ""],
    ["just whitespace", "   "],
  ])("treats %s of DATABASE_URL as SQLite", (_label, value) => {
    expect(loadDatabaseConfig({ DATABASE_URL: value })).toEqual({
      driver: "sqlite",
      path: "/data/app.db",
      busyTimeoutMs: 5000,
    });
  });

  // #105-PG-01
  it("takes a sqlite: URL as SQLite", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: "sqlite:/data/app.db" })).toEqual(
      {
        driver: "sqlite",
        path: "/data/app.db",
        busyTimeoutMs: 5000,
      },
    );
    expect(
      loadDatabaseConfig({ DATABASE_URL: "sqlite:///srv/app.db" }),
    ).toMatchObject({ driver: "sqlite", path: "/srv/app.db" });
  });

  // #105-PG-01
  it("takes a plain path as SQLite", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: "/srv/app.db" })).toMatchObject({
      driver: "sqlite",
      path: "/srv/app.db",
    });
    expect(loadDatabaseConfig({ DATABASE_URL: "./local.db" })).toMatchObject({
      driver: "sqlite",
      path: "./local.db",
    });
  });

  // #105-PG-01
  it("lets an explicit DATABASE_URL win over DATABASE_PATH", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_PATH: "/data/app.db",
        DATABASE_URL: "sqlite:/srv/other.db",
      }),
    ).toMatchObject({ driver: "sqlite", path: "/srv/other.db" });
  });

  it.each(["abc", "-1", "1.5", "0", "1e3", "0x10", "+5", "99999999999"])(
    "rejects the busy timeout %j with a stable error code",
    (value) => {
      const load = () =>
        loadDatabaseConfig({ DATABASE_BUSY_TIMEOUT_MS: value });

      expect(load).toThrow(DatabaseError);
      expect(load).toThrow(
        expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }),
      );
      expect(load).toThrow(/DATABASE_BUSY_TIMEOUT_MS/);
    },
  );
});

describe("loadDatabaseConfig: Postgres", () => {
  // #105-PG-01
  it("takes a postgres:// URL with its options", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgres://u:p@h:5432/db?sslmode=require",
      }),
    ).toEqual({
      driver: "postgres",
      url: "postgres://u:p@h:5432/db?sslmode=require",
      poolMax: DEFAULT_POOL_MAX,
    });
  });

  // #105-PG-01
  it("accepts postgresql:// too", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgresql://u:p@h/db",
      }),
    ).toMatchObject({ driver: "postgres", url: "postgresql://u:p@h/db" });
  });

  // #105-PG-01
  it("reads the optional pool size", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgres://u:p@h/db",
        DATABASE_POOL_MAX: "5",
      }),
    ).toMatchObject({ driver: "postgres", poolMax: 5 });
  });

  // #105-PG-02
  it.each([
    ["a URL of another scheme", "mysql://u:secret@h/db"],
    ["an http address", "http://u:secret@h/db"],
  ])("refuses %s with DATABASE_CONFIG_INVALID", (_label, value) => {
    const load = () => loadDatabaseConfig({ DATABASE_URL: value });

    expect(load).toThrow(
      expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }),
    );
    expect(load).not.toThrow(/secret/);
  });

  // #105-PG-02
  it.each(["postgres://", "postgres://u:secret@", "postgresql://:secret@"])(
    "refuses the invalid Postgres URL %j without echoing the password",
    (value) => {
      let message = "";
      try {
        loadDatabaseConfig({ DATABASE_URL: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/DATABASE_URL/);
      expect(message).not.toMatch(/secret/);
    },
  );

  it.each(["abc", "-1", "0", "1.5"])(
    "rejects the pool size %j with a stable error code",
    (value) => {
      const load = () =>
        loadDatabaseConfig({
          DATABASE_URL: "postgres://u:p@h/db",
          DATABASE_POOL_MAX: value,
        });

      expect(load).toThrow(
        expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }),
      );
      expect(load).toThrow(/DATABASE_POOL_MAX/);
    },
  );
});
