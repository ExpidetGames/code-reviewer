// Pins down what the claim hands to a runner (the LLM access) and how a missing configuration
// becomes the job error `llm_not_configured`; and that the key can be masked in any text.
import { describe, expect, it } from "vitest";
import { loadLlmConfig } from "./config.ts";
import {
  LLM_NOT_CONFIGURED_ERROR,
  createLlmAccess,
  maskSecretInText,
  resolveLlmAccess,
  revealLlmAccess,
} from "./access.ts";

const KEY = "dummy-llm-key-0123456789";
const validEnv = { LLM_PROVIDER: "openrouter", LLM_API_KEY: KEY };

describe("resolving the LLM access for a job", () => {
  // CR-26-T02 (the value comes from the environment at the time of the call)
  it("hands out the provider, the model and the key from the environment", () => {
    const result = resolveLlmAccess(
      loadLlmConfig({ ...validEnv, LLM_MODEL: "qwen/qwen3-coder" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.access.provider).toBe("openrouter");
    expect(result.access.model).toBe("qwen/qwen3-coder");
    expect(revealLlmAccess(result.access).apiKey).toBe(KEY);
  });

  it("reads a changed environment on the next call", () => {
    const first = resolveLlmAccess(loadLlmConfig(validEnv));
    const second = resolveLlmAccess(
      loadLlmConfig({ ...validEnv, LLM_API_KEY: "another-dummy-key" }),
    );

    if (!first.ok || !second.ok) throw new Error("expected both to resolve");
    expect(revealLlmAccess(first.access).apiKey).toBe(KEY);
    expect(revealLlmAccess(second.access).apiKey).toBe("another-dummy-key");
  });

  // CR-26-T06 (the claim of the runner API fails the job with this code)
  it("answers llm_not_configured with the affected variables when the key is missing", () => {
    const result = resolveLlmAccess(
      loadLlmConfig({ LLM_PROVIDER: "openrouter" }),
    );

    expect(result).toEqual({
      ok: false,
      errorCode: LLM_NOT_CONFIGURED_ERROR,
      issues: [{ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" }],
    });
    expect(LLM_NOT_CONFIGURED_ERROR).toBe("llm_not_configured");
  });

  it("answers llm_not_configured for an unknown provider", () => {
    const result = resolveLlmAccess(
      loadLlmConfig({ LLM_PROVIDER: "other", LLM_API_KEY: KEY }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("llm_not_configured");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("the LLM access value", () => {
  // CR-26-T07
  it("keeps the key out of JSON, spreads, entries and string output", () => {
    const access = createLlmAccess({
      provider: "openrouter",
      model: "m/x",
      apiKey: KEY,
      maxTokens: null,
    });

    expect(access.apiKey).toBe(KEY);
    expect(JSON.stringify(access)).not.toContain(KEY);
    expect(JSON.stringify({ ...access })).not.toContain(KEY);
    expect(JSON.stringify(Object.entries(access))).not.toContain(KEY);
    expect(String(access)).not.toContain(KEY);
  });

  it("refuses to reveal an access without a key", () => {
    const access = createLlmAccess({
      provider: "openrouter",
      model: "m/x",
      apiKey: "",
      maxTokens: null,
    });

    expect(() => revealLlmAccess(access)).toThrow(/no key/i);
  });
});

describe("masking a secret in a text", () => {
  // CR-26-T10
  it("replaces every occurrence of the secret", () => {
    const text = `401 for ${KEY}; retry with ${KEY} failed`;

    expect(maskSecretInText(text, KEY)).toBe(
      "401 for [redacted]; retry with [redacted] failed",
    );
  });

  it("masks the secret in its URL-encoded form too", () => {
    const secret = "key with+odd/chars=";
    const text = `GET /v1?k=${encodeURIComponent(secret)}`;

    expect(maskSecretInText(text, secret)).toBe("GET /v1?k=[redacted]");
  });

  it("leaves the text alone when the secret is empty", () => {
    expect(maskSecretInText("abc", "")).toBe("abc");
  });
});
