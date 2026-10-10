// Pins down what the settings page may show about the LLM access: provider and model when it works,
// the variable names and codes when it does not, and never the key.
import { describe, expect, it } from "vitest";
import { loadLlmConfig } from "./config.ts";
import { describeLlmStatus } from "./status.ts";

const KEY = "dummy-llm-key-0123456789";

describe("describing the LLM access for the UI", () => {
  it("shows the provider and the model of a working configuration", () => {
    const status = describeLlmStatus(
      loadLlmConfig({ LLM_PROVIDER: "openrouter", LLM_API_KEY: KEY }),
    );

    expect(status).toEqual({
      configured: true,
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
    });
  });

  // CR-26-T05 (the hint itself; the settings page that shows it belongs to the UI ticket)
  it("names the variable of a configuration error and never a value", () => {
    const status = describeLlmStatus(
      loadLlmConfig({ LLM_PROVIDER: "openrouter" }),
    );

    expect(status).toEqual({
      configured: false,
      issues: [{ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" }],
    });
  });

  // CR-26-T09
  it("never contains the key", () => {
    const working = describeLlmStatus(
      loadLlmConfig({ LLM_PROVIDER: "openrouter", LLM_API_KEY: KEY }),
    );
    const broken = describeLlmStatus(
      loadLlmConfig({ LLM_PROVIDER: KEY, LLM_API_KEY: KEY }),
    );

    expect(JSON.stringify(working)).not.toContain(KEY);
    expect(JSON.stringify(broken)).not.toContain(KEY);
  });
});
