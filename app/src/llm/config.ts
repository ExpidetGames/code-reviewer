// The LLM access a job gets, read from the environment. This is the minimum the runner API needs
// today; the LLM key ticket (CR-26) owns this module and extends it (settings per project, the
// default model, the cost check). Callers only use `loadLlmAccess` and `revealLlmAccess`.
import "server-only";

/** The providers the runner can talk to (see `llm.provider` in contracts/runner-api.v1.json). */
export const LLM_PROVIDERS = ["openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The model used when `LLM_MODEL` is not set: the default after the model comparison (CR-44, lead
 * decision). A project may choose another one (CR-25); this module is replaced by the LLM
 * configuration of CR-26.
 */
export const DEFAULT_LLM_MODEL = "anthropic/claude-haiku-5.5";

/** The stable code of a job that cannot start because the app has no usable LLM access. */
export const LLM_NOT_CONFIGURED = "llm_not_configured" as const;

/**
 * The LLM access of a job. `apiKey` is readable but not enumerable, so JSON.stringify, spreading
 * and console output leave it out; only `revealLlmAccess` hands it out, for the claim response.
 */
export type LlmAccess = {
  provider: LlmProvider;
  model: string;
  readonly apiKey: string;
};

export type LlmAccessResult =
  | { ok: true; access: LlmAccess }
  | { ok: false; errorCode: typeof LLM_NOT_CONFIGURED };

function isLlmProvider(value: string): value is LlmProvider {
  return LLM_PROVIDERS.some((provider) => provider === value);
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * Reads `LLM_PROVIDER` (default `openrouter`), `LLM_MODEL` (default `DEFAULT_LLM_MODEL`) and
 * `LLM_API_KEY`. A missing key or a provider the runner does not support is "not configured": the answer never says which setting is wrong, because it ends
 * up in a job's error code, not in a log of settings.
 */
export function loadLlmAccess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LlmAccessResult {
  const provider = present(env.LLM_PROVIDER) ?? "openrouter";
  const model = present(env.LLM_MODEL) ?? DEFAULT_LLM_MODEL;
  const apiKey = present(env.LLM_API_KEY);
  if (!isLlmProvider(provider) || apiKey === undefined)
    return { ok: false, errorCode: LLM_NOT_CONFIGURED };

  const access = { provider, model } as LlmAccess;
  Object.defineProperty(access, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
  });
  return { ok: true, access };
}

/** A plain copy with the key, for the claim response. Never log it, store it or cache it. */
export function revealLlmAccess(access: LlmAccess): {
  provider: LlmProvider;
  model: string;
  apiKey: string;
} {
  return {
    provider: access.provider,
    model: access.model,
    apiKey: access.apiKey,
  };
}
