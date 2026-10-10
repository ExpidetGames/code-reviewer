// Pins down how the database settings are read from the environment: defaults, overrides and the
// refusal of a busy timeout that cannot be used.
import { describe, expect, it } from "vitest";
import { DEFAULT_BUSY_TIMEOUT_MS, DEFAULT_DATABASE_PATH, loadDatabaseConfig } from "./config.ts";
import { DatabaseError } from "./errors.ts";

describe("loadDatabaseConfig", () => {
  it("uses /data/app.db and a 5000 ms busy timeout when nothing is configured", () => {
    expect(loadDatabaseConfig({})).toEqual({ path: "/data/app.db", busyTimeoutMs: 5000 });
    expect(DEFAULT_DATABASE_PATH).toBe("/data/app.db");
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000);
  });

  it("takes the database path and the busy timeout from the environment", () => {
    const config = loadDatabaseConfig({
      DATABASE_PATH: "/tmp/other.db",
      DATABASE_BUSY_TIMEOUT_MS: "250",
    });

    expect(config).toEqual({ path: "/tmp/other.db", busyTimeoutMs: 250 });
  });

  it("treats an empty database path as not configured", () => {
    expect(loadDatabaseConfig({ DATABASE_PATH: "  " }).path).toBe("/data/app.db");
  });

  it.each(["abc", "-1", "1.5", "0"])("rejects the busy timeout %j with a stable error code", (value) => {
    const load = () => loadDatabaseConfig({ DATABASE_BUSY_TIMEOUT_MS: value });

    expect(load).toThrow(DatabaseError);
    expect(load).toThrow(expect.objectContaining({ code: "DATABASE_CONFIG_INVALID" }));
    expect(load).toThrow(/DATABASE_BUSY_TIMEOUT_MS/);
  });
});
