// SPDX-License-Identifier: Apache-2.0

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

  // #104-LK-12
  it("says nothing when no LLM variable is set, because the workspaces bring their own key", () => {
    const warn = vi.fn();

    checkLlmConfigOnStart({ env: {}, warn });
    checkLlmConfigOnStart({ env: { LLM_PROVIDER: "" }, warn });

    expect(warn).not.toHaveBeenCalled();
  });

  // #104-LK-12
  it("warns about a key without a provider, which the fallback does not use, and about a provider without a key", () => {
    const keyOnly = vi.fn();
    const providerOnly = vi.fn();

    checkLlmConfigOnStart({ env: { LLM_API_KEY: KEY }, warn: keyOnly });
    checkLlmConfigOnStart({
      env: { LLM_PROVIDER: "openrouter" },
      warn: providerOnly,
    });

    expect(String(keyOnly.mock.calls[0]?.[0])).toContain(
      "LLM_PROVIDER_MISSING",
    );
    expect(String(providerOnly.mock.calls[0]?.[0])).toContain(
      "LLM_API_KEY_MISSING",
    );
    expect(JSON.stringify(keyOnly.mock.calls)).not.toContain(KEY);
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

  // CR-26-T03
  it("warns once with the code and the variable name about a legacy variable that is set but wrong, and does not stop the start", () => {
    const warn = vi.fn();

    expect(() =>
      checkLlmConfigOnStart({
        env: { LLM_PROVIDER: "openrouter", LLM_API_KEY: "has a space" },
        warn,
      }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("LLM_API_KEY_INVALID");
    expect(line).toContain("LLM_API_KEY");
    expect(line).not.toContain("has a space");
    expect(line).not.toContain("\n");
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
    expect(line).not.toContain("LLM_NOT_CONFIGURED");
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
