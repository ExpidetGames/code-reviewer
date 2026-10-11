// Pins down the start of the server: the LLM configuration is checked, a missing key only warns and
// the rest of the start (database, pins, sync) goes on. The other modules of the start are replaced
// by recorders; the LLM check is the real one, and so is the runner token check (it must stay quiet).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("./auth/startup.ts", () => ({
  checkAuthConfigOnStart: () => void calls.push("auth-check"),
  syncLoginPinsOnStart: async () => void calls.push("pins"),
}));
vi.mock("./auth/config.ts", () => ({
  loadAuthConfig: () => ({ access: {} }),
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
vi.mock("./integrations/sync/startup.ts", () => ({
  runStartupSync: async () => void calls.push("sync"),
}));
vi.mock("./backup/startup.ts", () => ({
  startBackupSchedulerOnStart: () => void calls.push("backup"),
}));

import { register } from "./instrumentation.ts";

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  // A usable runner token, so the start has nothing to say about the runner API (CR-28).
  vi.stubEnv("RUNNER_TOKEN", "dummy-runner-token-0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting the server", () => {
  // CR-26-T03
  it("warns about a missing LLM key and still starts", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LLM_API_KEY_MISSING");
    expect(calls).toEqual(["auth-check", "database", "pins", "sync", "backup"]);
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
      "database",
      "pins",
      "sync",
      "backup",
    ]);
  });

  // CR-40-T14
  it("starts the daily backup timer once the database is ready", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");

    await register();

    expect(calls).toContain("backup");
    expect(calls.indexOf("backup")).toBeGreaterThan(calls.indexOf("database"));
  });
});
