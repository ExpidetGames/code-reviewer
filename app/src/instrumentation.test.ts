// SPDX-License-Identifier: Apache-2.0

// Pins down the start of the server: the LLM options are checked, a wrong one only warns and the rest of
// the start (backup of an old database, database, import, setup code, sync) goes on in this order. The
// other modules of the start are replaced by recorders; the LLM check is the real one, and so is the runner
// token check (it must stay quiet).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("./auth/startup.ts", () => ({
  checkAuthConfigOnStart: () => void calls.push("auth-check"),
}));
// An installation from before accounts is backed up before the migrations and imported right after them; the
// real ones are tested in src/legacy-import/.
vi.mock("./legacy-import/backup-step.ts", () => ({
  backupBeforeUpdateOnStart: () => void calls.push("update-backup"),
}));
vi.mock("./legacy-import/startup.ts", () => ({
  importOnStart: async () => void calls.push("import"),
}));
// Stands for the production deployment check: it needs a moment to finish, and records only then. In
// every other environment the real check does nothing, so the stand-in records nothing either.
vi.mock("./deploy/startup.ts", () => ({
  checkDeploymentConfigOnStart: async () => {
    if (process.env.NODE_ENV !== "production") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
    calls.push("deploy-check");
  },
}));
vi.mock("./db/startup.ts", () => ({
  getDatabase: () => ({}),
  initializeDatabaseOnStart: async () => void calls.push("database"),
}));
// Where the GitHub App comes from (the database, or the variables of an installation that was not imported):
// the real store is tested in src/github-config/; the stand-in reads the variable the tests set.
vi.mock("./github-config/shared.ts", () => ({
  getGithubCredentialStore: () => ({
    load: async () => ({
      source: process.env.GITHUB_APP_ID ? "environment" : "none",
    }),
  }),
}));
// The setup code is printed once the database is ready; the real thing is tested in src/setup/.
vi.mock("./setup/start.ts", () => ({
  startSetupOnStart: async () => void calls.push("setup"),
}));
vi.mock("./setup/shared.ts", () => ({
  getSetupCodeStore: () => ({}),
}));
vi.mock("./integrations/sync/startup.ts", () => ({
  runStartupSync: async () => void calls.push("sync"),
}));
// The check of BACKUP_TIME stands for the real one, which ends the process on an invalid value
// (process.exit never returns); the stand-in throws, so the test sees that nothing after it ran.
vi.mock("./backup/startup.ts", () => ({
  checkBackupConfigOnStart: () => {
    calls.push("backup-check");
    if (process.env.BACKUP_TIME === "25:99") throw new Error("exit(1)");
  },
  startBackupSchedulerOnStart: () => void calls.push("backup"),
}));

// The cleanup of old rows: the real one is tested in src/maintenance/.
vi.mock("./maintenance/startup.ts", () => ({
  startCleanupOnStart: () => void calls.push("cleanup"),
}));

import { register } from "./instrumentation.ts";

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  // These are the server's start; the serverless one is pinned in instrumentation.serverless.test.ts. The CI job
  // that runs the unit suite with APP_RUNTIME=serverless (#319-T06) must not change which one this file tests.
  vi.stubEnv("APP_RUNTIME", "server");
  // A usable runner token, so the start has nothing to say about the runner API (CR-28).
  vi.stubEnv("RUNNER_TOKEN", "dummy-runner-token-0123456789abcdef");
  // An instance that is connected to GitHub; the case without is tested on its own.
  vi.stubEnv("GITHUB_APP_ID", "123456");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting the server", () => {
  // CR-26-T03
  it("warns about a wrong LLM option and still starts, in the order backup of an old database, migrations, import, setup code", async () => {
    vi.stubEnv("LLM_MODEL", "a model with spaces");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LLM_MODEL_INVALID");
    expect(calls).toEqual([
      "auth-check",
      "backup-check",
      "update-backup",
      "database",
      "import",
      "setup",
      "sync",
      "cleanup",
      "backup",
    ]);
  });

  it("says nothing about the LLM when its configuration is complete", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).not.toHaveBeenCalled();
    expect(calls).toContain("database");
  });

  // CR-38 review: the check ends the process on a bad configuration, so nothing may start before it
  // has finished (a `void` instead of an `await` would let the database open first).
  it("finishes the deployment check in production before the database is opened", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls).toEqual([
      "auth-check",
      "deploy-check",
      "backup-check",
      "update-backup",
      "database",
      "import",
      "setup",
      "sync",
      "cleanup",
      "backup",
    ]);
  });

  // #106-IM-17
  it("takes the backup of an old database before the migrations touch it, and imports after them and before the setup code is printed", async () => {
    await register();

    expect(calls.indexOf("update-backup")).toBeLessThan(
      calls.indexOf("database"),
    );
    expect(calls.indexOf("import")).toBeGreaterThan(calls.indexOf("database"));
    expect(calls.indexOf("import")).toBeLessThan(calls.indexOf("setup"));
  });

  // #97-SU-01
  it("prints the setup code after the database is ready and before the repositories are synchronized", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls.indexOf("setup")).toBeGreaterThan(calls.indexOf("database"));
    expect(calls.indexOf("setup")).toBeLessThan(calls.indexOf("sync"));
  });

  // #97-NOT-CONFIGURED
  it("does not synchronize with GitHub when no GitHub App variable is set, which is the normal state of an instance that is not connected", async () => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls).toContain("database");
    expect(calls).not.toContain("sync");
  });

  // CR-40-T14
  it("starts the daily backup timer once the database is ready", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls).toContain("backup");
    expect(calls.indexOf("backup")).toBeGreaterThan(calls.indexOf("database"));
  });

  // CR-76-T03
  it("checks the backup time before the database is opened and the repositories are synchronized", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls.indexOf("backup-check")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("backup-check")).toBeLessThan(
      calls.indexOf("database"),
    );
    expect(calls.indexOf("backup-check")).toBeLessThan(calls.indexOf("sync"));
  });

  // CR-76-T03
  it("stops at an invalid backup time before the sync or anything else after it starts", async () => {
    vi.stubEnv("BACKUP_TIME", "25:99");
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await expect(register()).rejects.toThrow("exit(1)");

    expect(calls).not.toContain("sync");
    expect(calls).not.toContain("database");
    expect(calls).not.toContain("backup");
  });
});
