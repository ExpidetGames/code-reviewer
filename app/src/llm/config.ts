// SPDX-License-Identifier: Apache-2.0

// Reads the shared LLM access from the environment. The only place that knows the variable names.
//
// One LLM account serves the whole instance (a key per project or per user comes later). The app
// hands the key to the runner with every job. A problem is a *state* ("misconfigured"), not an
// exception: the app starts anyway, the UI shows the problem and a job fails with `llm_not_configured`
// when it is claimed. Only the provider and the key can make the state misconfigured. A wrong
// optional value (`LLM_MODEL`, `LLM_MAX_TOKENS`) is ignored with the default used instead, and
// reported as a *warning* next to a working configuration: a typo in the model must not stop every
// review. A problem is reported with the variable name and a stable code, never with a value (the
// variables hold a secret, and a wrong value may be a secret pasted into the wrong place).
//
// The limits below are the ones the runner enforces on a job (runner/README.md, "llm"); a value the
// runner would refuse is refused here, so it shows up in the UI instead of as a failed job.

export const LLM_PROVIDERS = ["openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The model used when `LLM_MODEL` is not set: the recommendation of the model comparison (measured
 * 0.0027 USD per review on average against the customer's limit of 0.10 USD).
 */
export const DEFAULT_LLM_MODEL = "anthropic/claude-haiku-5.5";

export const LLM_VARIABLES = [
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
] as const;
export type LlmVariable = (typeof LLM_VARIABLES)[number];

export const LLM_CONFIG_ISSUE_CODES = [
  "LLM_PROVIDER_MISSING",
  "LLM_PROVIDER_UNKNOWN",
  "LLM_API_KEY_MISSING",
  "LLM_API_KEY_INVALID",
  "LLM_MODEL_INVALID",
  "LLM_MAX_TOKENS_INVALID",
] as const;
export type LlmConfigIssueCode = (typeof LLM_CONFIG_ISSUE_CODES)[number];

export type LlmConfigIssue = {
  code: LlmConfigIssueCode;
  variable: LlmVariable;
};

/** What the runner accepts for `llm.apiKey`, `llm.model` and `llm.maxTokens`. */
export const MAX_LLM_KEY_CHARS = 4096;
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
export const MIN_LLM_CONTEXT_TOKENS = 1000;
export const MAX_LLM_CONTEXT_TOKENS = 10_000_000;

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

export type LlmConfigState =
  | {
      status: "configured";
      config: LlmConfig;
      /** Optional variables that were wrong and are ignored (the default is used instead). */
      warnings: readonly LlmConfigIssue[];
    }
  | {
      status: "misconfigured";
      /** What stops reviews: the provider or the key. */
      issues: readonly LlmConfigIssue[];
      warnings: readonly LlmConfigIssue[];
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
 * Whether the legacy configuration is simply ABSENT: neither the provider nor the key is set. That is the normal
 * state of an instance whose workspaces bring their own key and nothing to report. One that is half set (a key
 * without a provider, or the other way round) or set but wrong is not absent: the instance admin hears about it.
 * The one rule for the resolver, the start-up warning and the notices.
 */
export function legacyConfigIsAbsent(
  issues: readonly LlmConfigIssue[],
): boolean {
  return (
    issues.length === 2 &&
    issues.some((issue) => issue.code === "LLM_API_KEY_MISSING") &&
    issues.some((issue) => issue.code === "LLM_PROVIDER_MISSING")
  );
}

/** Reads and validates the four variables. Never throws; never puts a value into the result. */
export function loadLlmConfig(env: Env): LlmConfigState {
  const issues: LlmConfigIssue[] = [];
  const warnings: LlmConfigIssue[] = [];

  const provider = readProvider(env.LLM_PROVIDER, issues);
  const apiKey = readApiKey(env.LLM_API_KEY, issues);
  const model = readModel(env.LLM_MODEL, warnings);
  const contextWindowTokens = readContextWindow(env.LLM_MAX_TOKENS, warnings);

  if (issues.length > 0 || provider === undefined || apiKey === undefined)
    return { status: "misconfigured", issues, warnings };

  return {
    status: "configured",
    config: createLlmConfig({ provider, model, apiKey, contextWindowTokens }),
    warnings,
  };
}

/**
 * What the environment says about the model and the context window, whether or not it holds a usable
 * provider and key: a workspace brings its own key, but the instance's `LLM_MODEL` and `LLM_MAX_TOKENS`
 * still describe the built-in model and the context window of a model PR-Agent does not know. Wrong values
 * are ignored and recorded as warnings, like in `loadLlmConfig`.
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

function readProvider(
  raw: string | undefined,
  issues: LlmConfigIssue[],
): LlmProvider | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    issues.push({ code: "LLM_PROVIDER_MISSING", variable: "LLM_PROVIDER" });
    return undefined;
  }
  const provider = LLM_PROVIDERS.find((known) => known === value);
  if (provider === undefined)
    issues.push({ code: "LLM_PROVIDER_UNKNOWN", variable: "LLM_PROVIDER" });
  return provider;
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

function readApiKey(
  raw: string | undefined,
  issues: LlmConfigIssue[],
): string | undefined {
  const checked = checkLlmApiKey(raw);
  if (checked.ok) return checked.key;
  issues.push({
    code:
      checked.problem === "missing"
        ? "LLM_API_KEY_MISSING"
        : "LLM_API_KEY_INVALID",
    variable: "LLM_API_KEY",
  });
  return undefined;
}

/** The model of `LLM_MODEL`, or the default when it is not set or not valid (a warning is recorded). */
function readModel(
  raw: string | undefined,
  warnings: LlmConfigIssue[],
): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_LLM_MODEL;
  if (!MODEL_NAME_PATTERN.test(value)) {
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
