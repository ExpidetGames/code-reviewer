// What a job gets from the shared LLM configuration, and how a missing configuration is reported.
//
// The claim of the runner API calls `resolveLlmAccess` once per claim, with the environment as it is
// at that moment (so a key that is fixed while the app runs is used by the next claim). A
// configuration that does not work fails the job with `llm_not_configured`; the job is not handed to
// the runner and not retried, because nothing a retry does can fix an environment variable.
import {
  type LlmConfig,
  type LlmConfigIssue,
  type LlmConfigState,
  type LlmProvider,
} from "./config.ts";

/** The job error code of a claim that found no usable LLM configuration. */
export const LLM_NOT_CONFIGURED_ERROR = "llm_not_configured" as const;

/**
 * The LLM part of a job. `apiKey` is readable but not enumerable (JSON, spreads, entries and console
 * output leave it out); only `revealLlmAccess` hands it out, for the runner API's claim response.
 */
export type LlmAccess = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  maxTokens: number | null;
};

export type LlmAccessResult =
  | { ok: true; access: LlmAccess }
  | {
      ok: false;
      errorCode: typeof LLM_NOT_CONFIGURED_ERROR;
      /** Which variables are wrong. Names and codes only, never a value. */
      issues: readonly LlmConfigIssue[];
    };

export function createLlmAccess(fields: LlmAccess): LlmAccess {
  const { apiKey, ...visible } = fields;
  const access = { ...visible };
  Object.defineProperty(access, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
  });
  return access as LlmAccess;
}

/**
 * A plain copy with the key included, for the one place that must send it on. Calling it is a
 * deliberate act; do not log, store or return its result to a browser. Throws when there is no key,
 * so a broken access is never sent to a runner as if it were usable.
 */
export function revealLlmAccess(access: LlmAccess): LlmAccess {
  if (typeof access.apiKey !== "string" || access.apiKey === "")
    throw new Error("The LLM access has no key to hand out.");
  return {
    provider: access.provider,
    model: access.model,
    apiKey: access.apiKey,
    maxTokens: access.maxTokens,
  };
}

function accessOf(config: LlmConfig): LlmAccess {
  return createLlmAccess({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    maxTokens: config.maxTokens,
  });
}

export function resolveLlmAccess(state: LlmConfigState): LlmAccessResult {
  if (state.status === "configured")
    return { ok: true, access: accessOf(state.config) };
  return {
    ok: false,
    errorCode: LLM_NOT_CONFIGURED_ERROR,
    issues: state.issues,
  };
}

const MASK = "[redacted]";

/**
 * Replaces every occurrence of a secret (and its URL-encoded form) in a text, for example an error
 * text a runner reports. An empty secret changes nothing.
 */
export function maskSecretInText(text: string, secret: string): string {
  if (secret === "") return text;
  let masked = text.split(secret).join(MASK);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) masked = masked.split(encoded).join(MASK);
  return masked;
}
