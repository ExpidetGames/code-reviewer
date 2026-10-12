// SPDX-License-Identifier: Apache-2.0

// Pins down the instance's LLM defaults (`LLM_MODEL`, `LLM_MAX_TOKENS`) and the one rule for an LLM
// key that the key routes, the legacy import and the workspace settings share. A wrong optional
// value is ignored with a warning, never a value in the result. The legacy `LLM_PROVIDER` and
// `LLM_API_KEY` are no longer read here (they were imported once, src/legacy-import/).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  LLM_CONFIG_ISSUE_CODES,
  checkLlmApiKey,
  configuredLlmModel,
  readLlmDefaults,
  type LlmConfigIssue,
} from "./config.ts";

const KEY = "dummy-llm-key-0123456789";

function warningsOf(env: Record<string, string | undefined>): LlmConfigIssue[] {
  return [...readLlmDefaults(env).warnings];
}

describe("reading the instance's LLM defaults", () => {
  it("uses the model of the model comparison as the default", () => {
    expect(DEFAULT_LLM_MODEL).toBe("anthropic/claude-haiku-5.5");
  });

  it("falls back to the default model and no context window when nothing is set", () => {
    const defaults = readLlmDefaults({});

    expect(defaults.model).toBe(DEFAULT_LLM_MODEL);
    expect(defaults.contextWindowTokens).toBeNull();
    expect(defaults.warnings).toEqual([]);
  });

  it("reads a model and a token limit when they are set", () => {
    const defaults = readLlmDefaults({
      LLM_MODEL: " qwen/qwen3-coder ",
      LLM_MAX_TOKENS: "120000",
    });

    expect(defaults.model).toBe("qwen/qwen3-coder");
    expect(defaults.contextWindowTokens).toBe(120000);
  });

  it("treats a blank model or token limit as not set", () => {
    const defaults = readLlmDefaults({ LLM_MODEL: "  ", LLM_MAX_TOKENS: "" });

    expect(defaults.model).toBe(DEFAULT_LLM_MODEL);
    expect(defaults.contextWindowTokens).toBeNull();
  });

  // A wrong optional variable never stops the reviews: the default is used and it is reported.
  it.each(["0", "999", "10000001", "12.5", "1e5", "-5", "12k"])(
    "ignores the token limit %s with a warning and keeps working",
    (value) => {
      const defaults = readLlmDefaults({ LLM_MAX_TOKENS: value });

      expect(defaults.contextWindowTokens).toBeNull();
      expect(defaults.warnings).toEqual([
        { code: "LLM_MAX_TOKENS_INVALID", variable: "LLM_MAX_TOKENS" },
      ]);
    },
  );

  it("accepts the smallest and the largest token limit the runner accepts", () => {
    for (const value of ["1000", "10000000"])
      expect(warningsOf({ LLM_MAX_TOKENS: value })).toEqual([]);
  });

  it.each(["bad model", "-start", "a".repeat(201), "mo\ndel"])(
    "ignores the model name %j with a warning and uses the default model",
    (value) => {
      const defaults = readLlmDefaults({ LLM_MODEL: value });

      expect(defaults.model).toBe(DEFAULT_LLM_MODEL);
      expect(defaults.warnings).toEqual([
        { code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" },
      ]);
    },
  );

  it("only uses issue codes from the stable list", () => {
    const warnings = readLlmDefaults({
      LLM_MODEL: "x y",
      LLM_MAX_TOKENS: "z",
    }).warnings;

    expect(warnings).toHaveLength(2);
    for (const issue of warnings)
      expect(LLM_CONFIG_ISSUE_CODES).toContain(issue.code);
  });
});

describe("the model of the instance", () => {
  it("is LLM_MODEL when it is set and valid", () => {
    expect(configuredLlmModel({ LLM_MODEL: " qwen/qwen3-coder " })).toBe(
      "qwen/qwen3-coder",
    );
  });

  // #104-LK-10 (the model of a workspace key is the same built-in value)
  it("is the default model when LLM_MODEL is missing, blank or invalid", () => {
    for (const value of [undefined, "", "  ", "bad model"])
      expect(configuredLlmModel({ LLM_MODEL: value })).toBe(DEFAULT_LLM_MODEL);
  });
});

describe("the one rule for an LLM key", () => {
  it("trims whitespace and a trailing line break", () => {
    expect(checkLlmApiKey(`  ${KEY}\n`)).toEqual({ ok: true, key: KEY });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["only spaces", "   \n\t "],
  ])("reports a %s key", (_label, value) => {
    expect(checkLlmApiKey(value)).toEqual({ ok: false, problem: "missing" });
  });

  it.each([
    ["has a space inside", "abc def"],
    ["has a line break inside", "abc\ndef"],
    ["has a control character", "abc\u0000def"],
    ["is longer than 4096 characters", "k".repeat(4097)],
  ])("refuses a key that %s without echoing it", (_label, value) => {
    const result = checkLlmApiKey(value);

    expect(result).toEqual({ ok: false, problem: "invalid" });
    expect(JSON.stringify(result)).not.toContain(value);
  });
});
