// SPDX-License-Identifier: Apache-2.0

// Pins down what the server says about the LLM when it starts: a wrong option is one warning with the
// code and the variable name, the start goes on, and no value is printed.
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

  // #104-LK-12
  it("says nothing when no LLM variable is set, because the workspaces bring their own key", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({ env: {}, warn });
    checkLlmConfigOnStart({ env: { LLM_PROVIDER: "" }, warn });

    expect(warn).not.toHaveBeenCalled();
  });

  // #106-IM-01
  it("says nothing about a provider or a key in the environment, even a wrong one: they were imported once and are not read", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({ env: { LLM_API_KEY: KEY }, warn });
    checkLlmConfigOnStart({ env: { LLM_PROVIDER: "openrouter" }, warn });
    checkLlmConfigOnStart({
      env: { LLM_PROVIDER: "nope", LLM_API_KEY: "has a space" },
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the test endpoints are switched on and when an address is named without the switch", () => {
    const on = vi.fn();
    const ignored = vi.fn();

    checkLlmConfigOnStart({
      env: {
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        LLM_API_BASE_URL: "http://127.0.0.1:9/api/v1",
      },
      warn: on,
    });
    checkLlmConfigOnStart({
      env: { LLM_API_BASE_URL: "http://127.0.0.1:9/api/v1" },
      warn: ignored,
    });

    expect(on).toHaveBeenCalledTimes(1);
    expect(String(on.mock.calls[0]?.[0])).toContain(
      "LLM_TEST_ENDPOINTS_ENABLED",
    );
    expect(ignored).toHaveBeenCalledTimes(1);
    expect(String(ignored.mock.calls[0]?.[0])).toContain(
      "LLM_API_BASE_URL_IGNORED",
    );
    expect(JSON.stringify(ignored.mock.calls)).not.toContain("127.0.0.1");
  });

  it("warns once about a wrong optional variable, names it, and says the default is used", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({
      env: {
        LLM_PROVIDER: "openrouter",
        LLM_API_KEY: KEY,
        LLM_MODEL: "bad model",
      },
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("LLM_OPTIONS_IGNORED");
    expect(line).toContain("LLM_MODEL_INVALID (LLM_MODEL)");
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
