// Pins down how the shared LLM access is read from the environment: what is required, what the
// defaults are, that a problem is reported as a state (the app starts anyway) with stable codes and
// variable names, and that the key never shows up in anything but `config.apiKey`.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  LLM_CONFIG_ISSUE_CODES,
  configuredLlmModel,
  loadLlmConfig,
  type LlmConfigIssue,
} from "./config.ts";

const KEY = "dummy-llm-key-0123456789";
const validEnv = { LLM_PROVIDER: "openrouter", LLM_API_KEY: KEY };

function issuesOf(env: Record<string, string | undefined>): LlmConfigIssue[] {
  const state = loadLlmConfig(env);
  if (state.status !== "misconfigured")
    throw new Error("expected a configuration error");
  return [...state.issues];
}

describe("loading the LLM configuration", () => {
  // CR-26-T01
  it("is configured when the provider and a key are set, and the model falls back to the default", () => {
    const state = loadLlmConfig(validEnv);

    expect(state.status).toBe("configured");
    if (state.status !== "configured") return;
    expect(state.config.provider).toBe("openrouter");
    expect(state.config.apiKey).toBe(KEY);
    expect(state.config.model).toBe(DEFAULT_LLM_MODEL);
    expect(state.config.maxTokens).toBeNull();
  });

  it("reads a model and a token limit when they are set", () => {
    const state = loadLlmConfig({
      ...validEnv,
      LLM_MODEL: " qwen/qwen3-coder ",
      LLM_MAX_TOKENS: "120000",
    });

    expect(state.status).toBe("configured");
    if (state.status !== "configured") return;
    expect(state.config.model).toBe("qwen/qwen3-coder");
    expect(state.config.maxTokens).toBe(120000);
  });

  it("treats a blank model or token limit as not set", () => {
    const state = loadLlmConfig({
      ...validEnv,
      LLM_MODEL: "  ",
      LLM_MAX_TOKENS: "",
    });

    expect(state.status).toBe("configured");
    if (state.status !== "configured") return;
    expect(state.config.model).toBe(DEFAULT_LLM_MODEL);
    expect(state.config.maxTokens).toBeNull();
  });

  it("accepts the provider name in any case and with surrounding spaces", () => {
    expect(
      loadLlmConfig({ ...validEnv, LLM_PROVIDER: "  OpenRouter " }).status,
    ).toBe("configured");
  });

  // CR-26-T11
  it("trims whitespace and a trailing line break from the key", () => {
    const state = loadLlmConfig({
      ...validEnv,
      LLM_API_KEY: `  ${KEY}\n`,
    });

    expect(state.status).toBe("configured");
    if (state.status !== "configured") return;
    expect(state.config.apiKey).toBe(KEY);
  });

  // CR-26-T03
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["only spaces", "   \n\t "],
  ])(
    "reports a configuration error with the variable name when the key is %s",
    (_label, value) => {
      const issues = issuesOf({ ...validEnv, LLM_API_KEY: value });

      expect(issues).toEqual([
        { code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" },
      ]);
    },
  );

  // CR-26-T04
  it("reports a configuration error when the provider is missing", () => {
    expect(issuesOf({ LLM_API_KEY: KEY })).toEqual([
      { code: "LLM_PROVIDER_MISSING", variable: "LLM_PROVIDER" },
    ]);
    expect(issuesOf({ LLM_PROVIDER: "  ", LLM_API_KEY: KEY })).toEqual([
      { code: "LLM_PROVIDER_MISSING", variable: "LLM_PROVIDER" },
    ]);
  });

  // CR-26-T04
  it("reports a configuration error when the provider is not known", () => {
    expect(issuesOf({ ...validEnv, LLM_PROVIDER: "openai" })).toEqual([
      { code: "LLM_PROVIDER_UNKNOWN", variable: "LLM_PROVIDER" },
    ]);
  });

  it("reports every problem at once", () => {
    const issues = issuesOf({
      LLM_PROVIDER: "nope",
      LLM_MODEL: "bad model",
      LLM_MAX_TOKENS: "many",
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "LLM_PROVIDER_UNKNOWN",
      "LLM_API_KEY_MISSING",
      "LLM_MODEL_INVALID",
      "LLM_MAX_TOKENS_INVALID",
    ]);
  });

  it.each([
    ["has a space inside", "abc def"],
    ["has a line break inside", "abc\ndef"],
    ["has a control character", "abc\u0000def"],
    ["is longer than 4096 characters", "k".repeat(4097)],
  ])("rejects a key that %s without echoing it", (_label, value) => {
    const issues = issuesOf({ ...validEnv, LLM_API_KEY: value });

    expect(issues).toEqual([
      { code: "LLM_API_KEY_INVALID", variable: "LLM_API_KEY" },
    ]);
    expect(JSON.stringify(issues)).not.toContain(value);
  });

  it.each(["0", "999", "10000001", "12.5", "1e5", "-5", "12k"])(
    "rejects the token limit %s",
    (value) => {
      expect(issuesOf({ ...validEnv, LLM_MAX_TOKENS: value })).toEqual([
        { code: "LLM_MAX_TOKENS_INVALID", variable: "LLM_MAX_TOKENS" },
      ]);
    },
  );

  it("accepts the smallest and the largest token limit the runner accepts", () => {
    for (const value of ["1000", "10000000"])
      expect(loadLlmConfig({ ...validEnv, LLM_MAX_TOKENS: value }).status).toBe(
        "configured",
      );
  });

  it.each(["bad model", "-start", "a".repeat(201), "mo\ndel"])(
    "rejects the model name %j",
    (value) => {
      expect(issuesOf({ ...validEnv, LLM_MODEL: value })).toEqual([
        { code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" },
      ]);
    },
  );

  it("only uses issue codes from the stable list", () => {
    const issues = issuesOf({
      LLM_PROVIDER: "x",
      LLM_API_KEY: "a b",
      LLM_MODEL: "x y",
      LLM_MAX_TOKENS: "z",
    });

    for (const issue of issues)
      expect(LLM_CONFIG_ISSUE_CODES).toContain(issue.code);
  });

  // CR-26-T07
  it("keeps the key out of JSON, spreads and error states", () => {
    const state = loadLlmConfig(validEnv);
    if (state.status !== "configured") throw new Error("expected configured");

    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(JSON.stringify({ ...state.config })).not.toContain(KEY);
    expect(Object.keys(state.config)).not.toContain("apiKey");
    const broken = loadLlmConfig({ ...validEnv, LLM_PROVIDER: KEY });
    expect(JSON.stringify(broken)).not.toContain(KEY);
  });

  it("does not echo a wrong provider value, which could be a pasted key", () => {
    const state = loadLlmConfig({ LLM_PROVIDER: KEY, LLM_API_KEY: KEY });

    expect(JSON.stringify(state)).not.toContain(KEY);
  });
});

describe("the model of the instance", () => {
  it("is LLM_MODEL when it is set and valid, even while another variable is wrong", () => {
    expect(configuredLlmModel({ LLM_MODEL: " qwen/qwen3-coder " })).toBe(
      "qwen/qwen3-coder",
    );
    expect(
      configuredLlmModel({ LLM_MODEL: "qwen/qwen3-coder", LLM_API_KEY: "" }),
    ).toBe("qwen/qwen3-coder");
  });

  it("is the default model when LLM_MODEL is missing, blank or invalid", () => {
    for (const value of [undefined, "", "  ", "bad model"])
      expect(configuredLlmModel({ LLM_MODEL: value })).toBe(DEFAULT_LLM_MODEL);
  });
});
