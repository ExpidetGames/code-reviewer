// SPDX-License-Identifier: Apache-2.0

// Pins down what the claim hands to a runner (the LLM access) and how a missing configuration
// becomes the job error `llm_not_configured`; and that the key can be masked in any text.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  LLM_NOT_CONFIGURED_ERROR,
  LlmAccessError,
  createLlmAccess,
  maskProviderInText,
  maskSecretInText,
  revealLlmAccess,
} from "./access.ts";

const KEY = "dummy-llm-key-0123456789";

describe("the failure of an access", () => {
  // CR-26-T06 (the claim of the runner API fails the job with this code)
  it("is the stable code llm_not_configured", () => {
    expect(LLM_NOT_CONFIGURED_ERROR).toBe("llm_not_configured");
  });
});

describe("the LLM access value", () => {
  // CR-26-T07
  it("keeps the key out of JSON, spreads, entries and string output", () => {
    const access = createLlmAccess({
      provider: "openrouter",
      model: "m/x",
      apiKey: KEY,
      contextWindowTokens: null,
    });

    expect(access.apiKey).toBe(KEY);
    expect(JSON.stringify(access)).not.toContain(KEY);
    expect(JSON.stringify({ ...access })).not.toContain(KEY);
    expect(JSON.stringify(Object.entries(access))).not.toContain(KEY);
    expect(inspect(access, { depth: 5 })).not.toContain(KEY);
    expect(`${JSON.stringify(access)}${String(access)}`).not.toContain(KEY);
  });

  it("refuses to reveal an access without a key", () => {
    const access = createLlmAccess({
      provider: "openrouter",
      model: "m/x",
      apiKey: "",
      contextWindowTokens: null,
    });

    let error: unknown;
    try {
      revealLlmAccess(access);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LlmAccessError);
    expect((error as LlmAccessError).code).toBe("LLM_ACCESS_HAS_NO_KEY");
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

  // The key may have been rotated since the claim: the caller passes the key of the claim and the
  // current one, and both are masked.
  it("masks several secrets, such as the key of the claim and the current key", () => {
    const text = "old old-key-0123 and new new-key-4567 failed";

    expect(maskSecretInText(text, "old-key-0123", "new-key-4567")).toBe(
      "old [redacted] and new [redacted] failed",
    );
  });

  it("masks the JSON-escaped and the base64 form", () => {
    const secret = 'key"with\\quote';
    const json = JSON.stringify({ message: secret });
    const basic = Buffer.from(secret).toString("base64");

    expect(maskSecretInText(json, secret)).toBe('{"message":"[redacted]"}');
    expect(maskSecretInText(`Basic ${basic}`, secret)).toBe("Basic [redacted]");
  });

  it("masks a secret that contains another one as a whole", () => {
    expect(maskSecretInText("a abcd b", "abcd", "bc")).toBe("a [redacted] b");
  });
});

describe("the name of a provider in a text", () => {
  // #435-T06
  it("is replaced in any letter case, inside a longer word, and for the label as well as the id", () => {
    expect(
      maskProviderInText("OpenrouterException: OpenRouter said (openrouter)", [
        "openrouter",
        "OpenRouter",
      ]),
    ).toBe("[provider]Exception: [provider] said ([provider])");
  });

  // #435-T06
  it("takes the longer name first, and treats a name as text and not as a pattern", () => {
    expect(
      maskProviderInText("the Open.Router (open-router) and Open.Router.AI", [
        "Open.Router",
        "Open.Router.AI",
      ]),
    ).toBe("the [provider] (open-router) and [provider]");
  });

  // #435-T06
  it("leaves a text alone when no name is given", () => {
    expect(maskProviderInText("OpenRouter", [])).toBe("OpenRouter");
  });
});
