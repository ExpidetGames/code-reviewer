// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { llmApiBaseUrl } from "./endpoint.ts";

describe("the address a key is checked at", () => {
  // #104-LK-09
  it("is the provider's own API by default", () => {
    expect(llmApiBaseUrl({}, "openrouter")).toEqual({
      url: "https://openrouter.ai/api/v1",
      overrideIgnored: false,
    });
  });

  // #104-LK-09
  it("ignores another address that the environment names unless the test flag is set", () => {
    expect(
      llmApiBaseUrl(
        { LLM_API_BASE_URL: "http://127.0.0.1:9/api/v1" },
        "openrouter",
      ),
    ).toEqual({ url: "https://openrouter.ai/api/v1", overrideIgnored: true });
    expect(
      llmApiBaseUrl(
        {
          LLM_API_BASE_URL: "http://127.0.0.1:9/api/v1",
          ALLOW_TEST_LLM_ENDPOINTS: "1",
        },
        "openrouter",
      ).overrideIgnored,
    ).toBe(true);
  });

  it("takes the address of the test stack with the flag", () => {
    expect(
      llmApiBaseUrl(
        {
          LLM_API_BASE_URL: "http://127.0.0.1:9/api/v1/",
          ALLOW_TEST_LLM_ENDPOINTS: "true",
        },
        "openrouter",
      ),
    ).toEqual({ url: "http://127.0.0.1:9/api/v1", overrideIgnored: false });
  });

  it("ignores an address that is not a URL", () => {
    expect(
      llmApiBaseUrl(
        {
          LLM_API_BASE_URL: "javascript:alert(1)",
          ALLOW_TEST_LLM_ENDPOINTS: "true",
        },
        "openrouter",
      ),
    ).toMatchObject({
      url: "https://openrouter.ai/api/v1",
      overrideIgnored: true,
    });
  });
});
