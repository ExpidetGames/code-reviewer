// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_OUTPUT_ALLOWANCE_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  dynamicCapabilitiesOf,
} from "./dynamic-capabilities.ts";
import type { ModelCapabilities } from "./model-capabilities.ts";

function metadata(
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: true,
    structuredOutputs: true,
    maxCompletionTokens: 393_216,
    smallestCompletionTokens: 131_072,
    contextLength: 1_048_576,
    inputUsdPerMtok: "0.6",
    outputUsdPerMtok: "2.4",
    ...overrides,
  };
}

describe("the capability descriptor of a Dynamic job", () => {
  // #279-T01
  it("carries the features, the window, the output allowance and the prices the metadata states", () => {
    expect(dynamicCapabilitiesOf(metadata())).toEqual({
      toolChoiceRequired: true,
      structuredOutput: true,
      maxOutputTokens: DYNAMIC_OUTPUT_ALLOWANCE_TOKENS,
      contextWindowTokens: 1_048_576,
      inputUsdPerMtok: "0.6",
      outputUsdPerMtok: "2.4",
    });
  });

  // #279-T01
  it("never offers more output than the model states, and never more than the allowance", () => {
    expect(
      dynamicCapabilitiesOf(metadata({ smallestCompletionTokens: 4096 }))
        ?.maxOutputTokens,
    ).toBe(4096);
    expect(
      dynamicCapabilitiesOf(metadata({ smallestCompletionTokens: null }))
        ?.maxOutputTokens,
    ).toBe(DYNAMIC_OUTPUT_ALLOWANCE_TOKENS);
    expect(
      dynamicCapabilitiesOf(metadata({ contextLength: 8000 }))?.maxOutputTokens,
    ).toBe(4000);
  });

  // #279: structured output goes through tool calling, so it needs tools, not `response_format`.
  it("derives structured output from tool calling", () => {
    expect(
      dynamicCapabilitiesOf(
        metadata({ responseFormat: false, structuredOutputs: false }),
      )?.structuredOutput,
    ).toBe(true);
    expect(
      dynamicCapabilitiesOf(metadata({ tools: false }))?.structuredOutput,
    ).toBe(false);
  });

  // #279-T06
  it("says so when the model cannot force a tool choice", () => {
    expect(
      dynamicCapabilitiesOf(metadata({ toolChoiceRequired: false }))
        ?.toolChoiceRequired,
    ).toBe(false);
  });

  // #279: prices are both there or both left out; the runner refuses the model without them.
  it("leaves the prices out when the metadata has none", () => {
    const descriptor = dynamicCapabilitiesOf(
      metadata({ inputUsdPerMtok: null, outputUsdPerMtok: null }),
    );

    expect(descriptor).not.toBeNull();
    expect(descriptor).not.toHaveProperty("inputUsdPerMtok");
    expect(descriptor).not.toHaveProperty("outputUsdPerMtok");
  });

  // #279: it never invents a window.
  it("is no descriptor when the metadata states no window", () => {
    expect(dynamicCapabilitiesOf(metadata({ contextLength: null }))).toBeNull();
  });

  // #279 (review): a window the contract cannot carry would make the runner refuse the whole job as
  // malformed; no descriptor makes it fall back to its own description instead.
  it("is no descriptor when the stated window is larger than the contract allows", () => {
    expect(
      dynamicCapabilitiesOf(
        metadata({ contextLength: MAX_CONTEXT_WINDOW_TOKENS }),
      )?.contextWindowTokens,
    ).toBe(MAX_CONTEXT_WINDOW_TOKENS);
    expect(
      dynamicCapabilitiesOf(
        metadata({ contextLength: MAX_CONTEXT_WINDOW_TOKENS + 1 }),
      ),
    ).toBeNull();
  });

  it("keeps the window bound equal to the contract's", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../../../contracts/runner-api.v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      $defs: {
        DynamicModelCapabilities: {
          properties: { contextWindowTokens: { maximum: number } };
        };
      };
    };

    expect(MAX_CONTEXT_WINDOW_TOKENS).toBe(
      contract.$defs.DynamicModelCapabilities.properties.contextWindowTokens
        .maximum,
    );
  });
});
