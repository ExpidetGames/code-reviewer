// Reads the shared LLM access from the environment. The only place that knows the variable names.
//
// One LLM account serves the whole instance (a key per project or per user comes later). The app
// hands the key to the runner with every job. A problem is a *state* ("misconfigured"), not an
// exception: the app starts anyway, the UI shows the problem and a job fails with `llm_not_configured`
// when it is claimed. A problem is reported with the variable name and a stable code, never with a
// value (the variables hold a secret, and a wrong value may be a secret pasted into the wrong place).
//
// The limits below are the ones the runner enforces on a job (runner/README.md, "llm"); a value the
// runner would refuse is refused here, so it shows up in the UI instead of as a failed job.

export const LLM_PROVIDERS = ["openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** The model used when `LLM_MODEL` is not set. Replaced by the recommendation of the model comparison. */
export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v3.2";

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
  /** The context window of a model PR-Agent does not know; null lets PR-Agent decide. */
  maxTokens: number | null;
};

export type LlmConfigState =
  | { status: "configured"; config: LlmConfig }
  | { status: "misconfigured"; issues: readonly LlmConfigIssue[] };

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

/** Reads and validates the four variables. Never throws; never puts a value into the result. */
export function loadLlmConfig(env: Env): LlmConfigState {
  const issues: LlmConfigIssue[] = [];

  const provider = readProvider(env.LLM_PROVIDER, issues);
  const apiKey = readApiKey(env.LLM_API_KEY, issues);
  const model = readModel(env.LLM_MODEL, issues);
  const maxTokens = readMaxTokens(env.LLM_MAX_TOKENS, issues);

  if (
    issues.length > 0 ||
    provider === undefined ||
    apiKey === undefined ||
    model === undefined ||
    maxTokens === undefined
  )
    return { status: "misconfigured", issues };

  return {
    status: "configured",
    config: createLlmConfig({ provider, model, apiKey, maxTokens }),
  };
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

function readApiKey(
  raw: string | undefined,
  issues: LlmConfigIssue[],
): string | undefined {
  const value = raw?.trim();
  if (!value) {
    issues.push({ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" });
    return undefined;
  }
  // A key with whitespace or control characters inside is a paste accident; the runner would refuse
  // the job anyway, so say so here.
  if (value.length > MAX_LLM_KEY_CHARS || /[\s\p{Cc}]/u.test(value)) {
    issues.push({ code: "LLM_API_KEY_INVALID", variable: "LLM_API_KEY" });
    return undefined;
  }
  return value;
}

function readModel(
  raw: string | undefined,
  issues: LlmConfigIssue[],
): string | undefined {
  const value = raw?.trim();
  if (!value) return DEFAULT_LLM_MODEL;
  if (!MODEL_NAME_PATTERN.test(value)) {
    issues.push({ code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" });
    return undefined;
  }
  return value;
}

/** `null` means "not set"; `undefined` means "set but invalid" (an issue was recorded). */
function readMaxTokens(
  raw: string | undefined,
  issues: LlmConfigIssue[],
): number | null | undefined {
  const value = raw?.trim();
  if (!value) return null;
  const number = /^[0-9]{1,8}$/.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isInteger(number) ||
    number < MIN_LLM_CONTEXT_TOKENS ||
    number > MAX_LLM_CONTEXT_TOKENS
  ) {
    issues.push({
      code: "LLM_MAX_TOKENS_INVALID",
      variable: "LLM_MAX_TOKENS",
    });
    return undefined;
  }
  return number;
}
