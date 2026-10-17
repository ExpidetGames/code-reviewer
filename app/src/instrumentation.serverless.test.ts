// SPDX-License-Identifier: Apache-2.0

// Pins down the start of a serverless instance (#319): the settings are checked, and none of the work
// of a long-lived server happens (migrations, the backup of an old database, the legacy import, the
// in-memory setup code, the GitHub sync, the cleanup, backup and check run timers: #405). A bad setting aborts the start
// with a thrown error, never with `process.exit`. The server start is pinned in instrumentation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forbidden: string[] = [];
const spied = (name: string) => () => void forbidden.push(name);
vi.mock("./legacy-import/backup-step.ts", () => ({
  backupBeforeUpdateOnStart: spied("update-backup"),
}));
vi.mock("./legacy-import/startup.ts", () => ({
  importOnStart: async () => void forbidden.push("import"),
}));
vi.mock("./backup/startup.ts", () => ({
  checkBackupConfigOnStart: spied("backup-check"),
  startBackupSchedulerOnStart: spied("backup"),
}));
vi.mock("./setup/start.ts", () => ({
  startSetupOnStart: async () => void forbidden.push("setup"),
}));
vi.mock("./integrations/sync/startup.ts", () => ({
  runStartupSync: async () => void forbidden.push("sync"),
}));
vi.mock("./maintenance/startup.ts", () => ({
  startCleanupOnStart: spied("cleanup"),
}));
vi.mock("./check-runs/startup.ts", () => ({
  startCheckReconcilerOnStart: spied("check-run-timer"),
}));
vi.mock("./db/startup.ts", () => ({
  getDatabase: () => {
    forbidden.push("getDatabase");
    return {};
  },
  initializeDatabaseOnStart: async () => void forbidden.push("database"),
}));

import { register } from "./instrumentation.ts";

beforeEach(() => {
  forbidden.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("APP_RUNTIME", "serverless");
  vi.stubEnv("APP_SECRET", "a-test-secret-of-at-least-32-characters-long");
  vi.stubEnv("BETTER_AUTH_URL", "https://reviews.example.test");
  vi.stubEnv("RUNNER_TOKEN", "dummy-runner-token-0123456789abcdef");
  vi.stubEnv("DATABASE_URL", "postgres://app:s3cr3t-pw@127.0.0.1:1/app");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting a serverless instance", () => {
  // #405-T32
  it("starts no check run timer: the sweep and the requests reconcile the check runs of a hosted deployment", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await register();

    expect(forbidden).not.toContain("check-run-timer");
    expect(forbidden).toEqual([]);
  });

  // #319-T01
  it("starts no timer, sync, backup or import, and does not even touch the database", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const exit = vi.spyOn(process, "exit");

    await register();

    expect(forbidden).toEqual([]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T01
  it("starts the same way when the platform marker alone selects serverless", async () => {
    vi.stubEnv("APP_RUNTIME", "");
    vi.stubEnv("VERCEL", "1");

    await register();

    expect(forbidden).toEqual([]);
  });

  // #319-T04
  it("refuses SQLite with a clear error that names no value, and does not exit the process", async () => {
    vi.stubEnv("DATABASE_URL", "sqlite:///data/secret-name.db");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    const failure = await register().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(Error);
    const text = [
      String((failure as Error).message),
      ...error.mock.calls.map((call) => String(call[0])),
    ].join("\n");
    expect(text).toContain("DATABASE_SERVERLESS_NEEDS_POSTGRES");
    expect(text).not.toContain("secret-name");
    expect(exit).not.toHaveBeenCalled();
    expect(forbidden).toEqual([]);
  });

  // #319-T02
  it("aborts a start with an incomplete deployment by throwing, not by process.exit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RUNNER_TOKEN", "");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    await expect(register()).rejects.toThrow(/start was aborted/);

    expect(
      error.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("RUNNER_TOKEN");
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T02
  it("aborts a start with a missing master key by throwing, not by process.exit", async () => {
    vi.stubEnv("APP_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    await expect(register()).rejects.toThrow(/start was aborted/);

    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T06
  it("refuses an unknown APP_RUNTIME instead of guessing a mode", async () => {
    vi.stubEnv("APP_RUNTIME", "lambda");

    await expect(register()).rejects.toThrow(/APP_RUNTIME/);
  });
});
