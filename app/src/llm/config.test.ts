// Pins down how the LLM access for a job is read from the environment: what counts as configured,
// that a missing key is reported with a stable code, and that the key stays out of logs.
import { describe, expect, it } from "vitest";
import { loadLlmAccess, revealLlmAccess } from "./config.ts";

const ENV = {
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: "dummy-llm-key-value",
  LLM_MODEL: "vendor/model-name",
};

describe("reading the LLM access from the environment", () => {
  it("returns the provider, model and key when all three are set", () => {
    const result = loadLlmAccess(ENV);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(revealLlmAccess(result.access)).toStrictEqual({
      provider: "openrouter",
      model: "vendor/model-name",
      apiKey: "dummy-llm-key-value",
    });
  });

  it("uses OpenRouter when no provider is named", () => {
    const result = loadLlmAccess({ ...ENV, LLM_PROVIDER: undefined });

    expect(result.ok && result.access.provider).toBe("openrouter");
  });

  it.each([
    ["no key", { LLM_API_KEY: undefined }],
    ["an empty key", { LLM_API_KEY: "" }],
    ["a blank key", { LLM_API_KEY: "   " }],
    ["no model", { LLM_MODEL: undefined }],
    ["a blank model", { LLM_MODEL: " " }],
  ])("is not configured with %s", (_name, override) => {
    expect(loadLlmAccess({ ...ENV, ...override })).toStrictEqual({
      ok: false,
      code: "llm_not_configured",
    });
  });

  it("is not configured for a provider the runner does not support", () => {
    expect(loadLlmAccess({ ...ENV, LLM_PROVIDER: "other" })).toStrictEqual({
      ok: false,
      code: "llm_not_configured",
    });
  });

  it("does not show the key in JSON, spreads or console output", () => {
    const result = loadLlmAccess(ENV);
    if (!result.ok) throw new Error("expected a configured access");

    expect(JSON.stringify(result.access)).not.toContain("dummy-llm-key-value");
    expect(JSON.stringify({ ...result.access })).not.toContain(
      "dummy-llm-key-value",
    );
    expect(Object.keys(result.access)).not.toContain("apiKey");
    expect(result.access.apiKey).toBe("dummy-llm-key-value");
  });
});
