// SPDX-License-Identifier: Apache-2.0

// The instance's LLM defaults and the one rule for a key. Two things live here:
//
// - `readLlmDefaults`: the built-in model (`LLM_MODEL`) and the context window (`LLM_MAX_TOKENS`) of the
//   instance. A wrong optional value is ignored with the default used instead, and reported as a
//   *warning*: a typo in the model must not stop every review. A problem is reported with the variable
//   name and a stable code, never with a value.
// - `checkLlmApiKey`, the one rule for an LLM key, shared by the key routes of a workspace
//   (src/llm/*), the legacy import (src/legacy-import/, which reads the old `LLM_API_KEY` once) and
//   nothing else. The key of a workspace is a matter of that workspace (BYOK, src/llm/), not of the
//   instance: the old instance-wide provider and key (`LLM_PROVIDER`, `LLM_API_KEY`) were imported once
//   and are no longer read here.
//
// The limits below are the ones the runner enforces on a job (runner/README.md, "llm"); a value the
// runner would refuse is refused here, so it shows up in the UI instead of as a failed job.

import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
  type LlmProviderId,
} from "./providers/index.ts";

/** The supported providers, from the registry (src/llm/providers/): adding a provider adds it here. */
export const LLM_PROVIDERS = llmProviderDescriptors.ids;
export type LlmProvider = LlmProviderId;

/**
 * The model used when `LLM_MODEL` is not set: the default Diff model of the default provider (for the
 * built-in one the recommendation of the model comparison).
 */
export const DEFAULT_LLM_MODEL =
  llmProviderDescriptors.defaultProvider.defaultModels.diff;

/** The variables that configure the instance's LLM defaults (the import reads the legacy ones once). */
export const LLM_DEFAULT_VARIABLES = ["LLM_MODEL", "LLM_MAX_TOKENS"] as const;
export type LlmDefaultVariable = (typeof LLM_DEFAULT_VARIABLES)[number];

export const LLM_CONFIG_ISSUE_CODES = [
  "LLM_MODEL_INVALID",
  "LLM_MAX_TOKENS_INVALID",
] as const;
export type LlmConfigIssueCode = (typeof LLM_CONFIG_ISSUE_CODES)[number];

export type LlmConfigIssue = {
  code: LlmConfigIssueCode;
  variable: LlmDefaultVariable;
};

/** What the runner accepts for `llm.apiKey`, `llm.model` and `llm.maxTokens`. */
export const MAX_LLM_KEY_CHARS = 4096;
export const MIN_LLM_CONTEXT_TOKENS = 1000;
export const MAX_LLM_CONTEXT_TOKENS = 10_000_000;

/**
 * Whether `model` has the shape of a model id of the provider: the rule of the provider's adapter, which is
 * what its runner accepts for `llm.model`. A model id that fails it is never sent anywhere. The provider is
 * a required argument: a caller that has none yet passes `DEFAULT_LLM_PROVIDER`, so the day a project can choose it
 * is a place to change, not a silent default.
 */
export function isModelId(model: string, provider: LlmProvider): boolean {
  return llmProviderDescriptors.get(provider).checkModelId(model);
}

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  /** Not enumerable (see `createLlmConfig`): JSON, spreads and logs leave it out. */
  apiKey: string;
  /**
   * The context window (`LLM_MAX_TOKENS`) of a model PR-Agent does not know; null lets PR-Agent
   * decide. Not the token budget of a review: that is a review setting (src/review-settings) and
   * replaces this value in a job.
   */
  contextWindowTokens: number | null;
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Builds an `LlmConfig` whose `apiKey` is readable (`config.apiKey`) but not enumerable, so passing
 * the object to a logger, an error or `JSON.stringify` cannot leak the key.
 */
export function createLlmConfig(fields: LlmConfig): LlmConfig {
  const { apiKey, ...visible } = fields;
  const config = { ...visible };
  Object.defineProperty(config, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
  });
  return config as LlmConfig;
}

/**
 * What the environment says about the model and the context window, whether or not it holds a usable
 * provider and key: a workspace brings its own key, but the instance's `LLM_MODEL` and `LLM_MAX_TOKENS`
 * still describe the built-in model and the context window of a model PR-Agent does not know. Wrong values
 * are ignored and recorded as warnings.
 */
export type LlmDefaults = {
  model: string;
  contextWindowTokens: number | null;
  warnings: readonly LlmConfigIssue[];
};

export function readLlmDefaults(env: Env): LlmDefaults {
  const warnings: LlmConfigIssue[] = [];
  const model = readModel(env.LLM_MODEL, warnings);
  const contextWindowTokens = readContextWindow(env.LLM_MAX_TOKENS, warnings);
  return { model, contextWindowTokens, warnings };
}

/**
 * The model the instance uses unless the review settings choose another: `LLM_MODEL` when it is set
 * and valid, otherwise the default model. Read on its own so the review settings still have a model
 * while the provider or the key is wrong.
 */
export function configuredLlmModel(env: Env): string {
  return readModel(env.LLM_MODEL, []);
}

/**
 * The one rule for an LLM key, whether it comes from the environment or from a workspace's settings:
 * surrounding whitespace is ignored, an empty key is `missing`, and a key with whitespace or control
 * characters inside, or over 4096 characters, is `invalid` (a paste accident; the runner would refuse the
 * job anyway). Never puts the value into the result of a refusal.
 */
export function checkLlmApiKey(
  raw: string | undefined,
): { ok: true; key: string } | { ok: false; problem: "missing" | "invalid" } {
  const value = raw?.trim();
  if (!value) return { ok: false, problem: "missing" };
  if (value.length > MAX_LLM_KEY_CHARS || /[\s\p{Cc}]/u.test(value))
    return { ok: false, problem: "invalid" };
  return { ok: true, key: value };
}

/** The model of `LLM_MODEL`, or the default when it is not set or not valid (a warning is recorded). */
function readModel(
  raw: string | undefined,
  warnings: LlmConfigIssue[],
): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_LLM_MODEL;
  if (!isModelId(value, DEFAULT_LLM_PROVIDER)) {
    warnings.push({ code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" });
    return DEFAULT_LLM_MODEL;
  }
  return value;
}

/** `null` when `LLM_MAX_TOKENS` is not set, or not valid (a warning is recorded in that case). */
function readContextWindow(
  raw: string | undefined,
  warnings: LlmConfigIssue[],
): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const number = /^[0-9]{1,8}$/.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isInteger(number) ||
    number < MIN_LLM_CONTEXT_TOKENS ||
    number > MAX_LLM_CONTEXT_TOKENS
  ) {
    warnings.push({
      code: "LLM_MAX_TOKENS_INVALID",
      variable: "LLM_MAX_TOKENS",
    });
    return null;
  }
  return number;
}
