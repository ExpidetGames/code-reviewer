// SPDX-License-Identifier: LicenseRef-Proprietary

// What the adapter knows about a model, answered from the list in `models.ts`: no network call, no credential.
// Another provider's public metadata has to be asked; here the list is the source, so the answer cannot fail or
// be spoofed, and it is the same on every call.
//
// `supported` means what it means for every provider (src/llm/model-capabilities.ts): the model can serve a
// Dynamic Review, which needs tools and an answer through the return tool. A model that takes no forced tool choice
// or always thinks (Fable 5.1, Opus 5.5, Sonnet 5.5, Fable 5) is supported too: the runner's wire steers it (#533),
// so `toolChoiceRequired` here says the run can get its answer through the tool, not that the API is asked to force
// it. A model of the list without that is `unsupported`; a Diff Review does not ask. An id that is not in the list is
// `unknown_model`, never a request.
import type { LlmProviderOperations, ModelCapabilities } from "../types.ts";
import { anthropicModel } from "./models.ts";

/** "0.50" and "0.5" are one price; the descriptor of a job carries the short form. */
const decimal = (price: string): string => String(Number(price));

export const checkModelCapabilities: LlmProviderOperations["checkModelCapabilities"] =
  ({ modelId }) => {
    const model = anthropicModel(modelId);
    if (model === undefined)
      return Promise.resolve({ outcome: "unknown_model" as const });
    const dynamic = model.reviewKinds.includes("dynamic");
    // The most a request can cost per token is the price of the higher tier (Haiku 5.5, a prompt over 100000 tokens):
    // the descriptor of a Dynamic job reserves against it.
    const top = model.longPrompt?.pricesUsdPerMTok ?? model.pricesUsdPerMTok;
    const capabilities: ModelCapabilities = {
      tools: model.supports.tools,
      toolChoice: model.supports.tools,
      toolChoiceRequired: dynamic,
      responseFormat: false,
      structuredOutputs: false,
      maxCompletionTokens: model.maxOutputTokens,
      smallestCompletionTokens: model.maxOutputTokens,
      contextLength: model.contextWindowTokens,
      inputUsdPerMtok: decimal(top.input),
      outputUsdPerMtok: decimal(top.output),
      // Thinking counts against `max_tokens` ("a hard cap on total output for the request, thinking and response text
      // combined"; "a `max_tokens` sized for a response with no thinking is often too small once Claude starts
      // thinking", `build-with-claude/thinking-steering-and-cost`, "Cost control", read on 2026-10-19), so the
      // descriptor gives these models a larger output allowance (src/llm/dynamic-capabilities.ts).
      alwaysThinks: !model.supports.thinkingDisabled,
    };
    return Promise.resolve({
      outcome: dynamic ? ("supported" as const) : ("unsupported" as const),
      capabilities,
    });
  };
