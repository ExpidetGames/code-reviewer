// SPDX-License-Identifier: Apache-2.0

// What a model costs, as a small static table. Data only: the model comparison ticket (CR-44) keeps
// it up to date together with the recommended default model.
//
// Source: the `pricing` of each model in OpenRouter's model list (`GET /api/v1/models`), which is
// USD per token; the numbers below are per million tokens. `PRICING_AS_OF` is the day the list was
// read; the model comparison (docs/spike/cr-44-model-comparison.md) used the same list and measured
// the cost of real reviews against it. A model that is not in the table has no estimate (the cost
// guard says "cost unknown" and warns), which is never an error: any OpenRouter model may be chosen.
//
// `inputTokenFactor` corrects the prompt size for the tokenizer: PR-Agent counts and cuts the diff in
// its own tokens (about 32k for a large pull request), and the models count differently. The same
// diff is 45k tokens for Claude (factor 1.4), about 41k for Gemini and 31k for DeepSeek and GPT
// (measured in the model comparison). Without the factor a Claude review is estimated 40 percent too
// cheap on the input side.
//
// To update: read the list, copy `prompt` and `completion` times 1,000,000 and `context_length` for
// the models worth choosing, change `PRICING_AS_OF`, and run the tests.

export type ModelPrice = {
  /** USD per million input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per million output (completion) tokens. */
  outputPerMillion: number;
  /** The context window of the model, in tokens. */
  contextTokens: number;
  /** The model's tokens per token PR-Agent counts in the prompt. 1 unless measured otherwise. */
  inputTokenFactor: number;
};

export const PRICING_AS_OF = "2026-10-10";

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "deepseek/deepseek-v3.2": {
    inputPerMillion: 0.259,
    outputPerMillion: 0.8,
    contextTokens: 163_840,
    inputTokenFactor: 1,
  },
  "deepseek/deepseek-v4-flash": {
    inputPerMillion: 0.021,
    outputPerMillion: 1.28,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "deepseek/deepseek-v4.1-flash": {
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "deepseek/deepseek-v4-pro": {
    inputPerMillion: 0.948,
    outputPerMillion: 1.897,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "qwen/qwen3-coder": {
    inputPerMillion: 0.3,
    outputPerMillion: 1.0,
    contextTokens: 262_144,
    inputTokenFactor: 1,
  },
  "qwen/qwen3.7-flash": {
    inputPerMillion: 0.03,
    outputPerMillion: 0.13,
    contextTokens: 1_000_000,
    inputTokenFactor: 1,
  },
  "qwen/qwen3.8-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.47,
    contextTokens: 1_000_000,
    inputTokenFactor: 1,
  },
  "z-ai/glm-4.7": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.2,
    contextTokens: 204_800,
    inputTokenFactor: 1,
  },
  "z-ai/glm-5.3-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.5,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "minimax/minimax-m3": {
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "moonshotai/kimi-k2.6": {
    inputPerMillion: 0.465,
    outputPerMillion: 2.45,
    contextTokens: 262_144,
    inputTokenFactor: 1,
  },
  "google/gemini-3.8-flash": {
    inputPerMillion: 0.75,
    outputPerMillion: 3.75,
    contextTokens: 1_048_576,
    inputTokenFactor: 1,
  },
  "openai/gpt-5.4-mini": {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    contextTokens: 400_000,
    inputTokenFactor: 1,
  },
  "openai/gpt-5.5": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    contextTokens: 1_050_000,
    inputTokenFactor: 1,
  },
  "anthropic/claude-haiku-5.5": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    contextTokens: 1_000_000,
    inputTokenFactor: 1.4,
  },
  "anthropic/claude-sonnet-5.5": {
    inputPerMillion: 2,
    outputPerMillion: 10,
    contextTokens: 1_000_000,
    inputTokenFactor: 1.4,
  },
  "anthropic/claude-opus-5.5": {
    inputPerMillion: 4,
    outputPerMillion: 20,
    contextTokens: 1_000_000,
    inputTokenFactor: 1.4,
  },
  "moonshotai/kimi-k2.7-code": {
    inputPerMillion: 0.671,
    outputPerMillion: 3.35,
    contextTokens: 262_144,
    inputTokenFactor: 1,
  },
  "qwen/qwen3-coder-next": {
    inputPerMillion: 0.12,
    outputPerMillion: 0.8,
    contextTokens: 262_144,
    inputTokenFactor: 1,
  },
  "mistralai/devstral-2512": {
    inputPerMillion: 0.4,
    outputPerMillion: 2.0,
    contextTokens: 262_144,
    inputTokenFactor: 1,
  },
  "x-ai/grok-4.3": {
    inputPerMillion: 1.25,
    outputPerMillion: 2.5,
    contextTokens: 1_000_000,
    inputTokenFactor: 1,
  },
  "z-ai/glm-5.1": {
    inputPerMillion: 0.966,
    outputPerMillion: 3.036,
    contextTokens: 204_800,
    inputTokenFactor: 1,
  },
};
