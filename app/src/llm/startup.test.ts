// Pins down what the server says about the LLM access when it starts: a problem is one warning with
// the code and the variable names, the start goes on, and no value is printed.
import { describe, expect, it, vi } from "vitest";
import { checkLlmConfigOnStart } from "./startup.ts";

const KEY = "dummy-llm-key-0123456789";

describe("checking the LLM configuration when the server starts", () => {
  it("says nothing about a complete configuration", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({
      env: { LLM_PROVIDER: "openrouter", LLM_API_KEY: KEY },
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  // CR-26-T03
  it("warns once with the code and the variable name and does not stop the start", () => {
    const warn = vi.fn();

    expect(() =>
      checkLlmConfigOnStart({ env: { LLM_PROVIDER: "openrouter" }, warn }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("LLM_API_KEY_MISSING");
    expect(line).toContain("LLM_API_KEY");
    expect(line).not.toContain("\n");
  });

  // CR-26-T07
  it("never prints a value, not even a wrong one", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({
      env: {
        LLM_PROVIDER: KEY,
        LLM_API_KEY: "has a space " + KEY,
        LLM_MODEL: KEY + " x",
        LLM_MAX_TOKENS: KEY,
      },
      warn,
    });

    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});
