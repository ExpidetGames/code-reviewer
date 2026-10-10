// Pins down that the running server reads the LLM variables from the process environment on every
// call: a value changed while the app runs is used by the next claim and the next page load.
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealLlmAccess } from "./access.ts";
import { getLlmAccess, getLlmStatus } from "./shared.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reading the LLM configuration of the running server", () => {
  // CR-26-T02 (the claim of the runner API uses getLlmAccess)
  it("uses the key the environment holds at the time of the call", () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "first-dummy-key");
    const first = getLlmAccess();
    vi.stubEnv("LLM_API_KEY", "second-dummy-key");
    const second = getLlmAccess();

    if (!first.ok || !second.ok) throw new Error("expected both to resolve");
    expect(revealLlmAccess(first.access).apiKey).toBe("first-dummy-key");
    expect(revealLlmAccess(second.access).apiKey).toBe("second-dummy-key");
  });

  it("reports the missing key as soon as the variable is gone", () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-key-value");
    expect(getLlmStatus().configured).toBe(true);
    vi.stubEnv("LLM_API_KEY", "");

    const status = getLlmStatus();

    expect(status).toEqual({
      configured: false,
      issues: [{ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" }],
    });
  });
});
