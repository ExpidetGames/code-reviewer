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
vi.mock("./db/startup.ts", () => ({
  getDatabase: () => ({}),
  initializeDatabaseOnStart: async () => void calls.push("database"),
}));
vi.mock("./integrations/sync/startup.ts", () => ({
  runStartupSync: async () => void calls.push("sync"),
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
    expect(calls).toEqual(["auth-check", "database", "pins", "sync"]);
  });

  it("says nothing about the LLM when its configuration is complete", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).not.toHaveBeenCalled();
    expect(calls).toContain("database");
  });
});
