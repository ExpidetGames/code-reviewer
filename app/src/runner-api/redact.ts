// SPDX-License-Identifier: Apache-2.0

// Takes secrets out of what a runner reports before it is stored. The runner redacts its own
// output (that is the first line of defense); this is the second one, for a runner that got it
// wrong: strings that look like credentials, and the secrets the app itself holds.
import "server-only";
import { maskSecretInText } from "../llm/access.ts";
import type { RunnerResult } from "./contract.ts";

export const REDACTED = "[redacted]";

/** A secret shorter than this is more likely an ordinary word than a credential. */
const MIN_SECRET_LENGTH = 8;

// GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained github_pat_), the `sk-` keys
// of the LLM providers, the per-job credential of a Worker (`crj_`, #320) and the credential of an
// `Authorization: Bearer` line.
const SECRET_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:or-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bcrj_[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

/**
 * The secrets the app itself holds in its environment, as they are used: surrounding white space is not
 * part of a setting (the LLM key is trimmed before it is handed to a runner, the runner token before it is
 * compared), so it is trimmed here as well. Empty settings are left out. (`LLM_API_KEY` is the legacy key of
 * a single-tenant instance; the key of a workspace is added by the caller, see `runner-api/shared.ts`.)
 */
export function knownSecretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return [env.LLM_API_KEY, env.RUNNER_TOKEN]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value !== "");
}

/**
 * `secrets` are the exact values the app knows (see `knownSecretsFromEnv`, and the key of the claim of
 * the job). Each is removed as it is and in its URL-encoded, JSON-escaped and base64 form, which is how
 * it appears in a request line, a logged body or an `Authorization: Basic` header (`maskSecretInText`).
 */
export function redactText(text: string, secrets: readonly string[]): string {
  const usable = secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  let cleaned = maskSecretInText(text, ...usable);
  for (const shape of SECRET_SHAPES) cleaned = cleaned.replace(shape, REDACTED);
  return cleaned;
}

/** The text fields of a result, cleaned. The structure and the numbers are not touched. */
export function redactResult(
  result: RunnerResult,
  secrets: readonly string[],
): RunnerResult {
  return {
    ...result,
    logTail: redactText(result.logTail, secrets),
    errorMessage:
      result.errorMessage === null
        ? null
        : redactText(result.errorMessage, secrets),
    commentUrl:
      result.commentUrl === null
        ? null
        : redactText(result.commentUrl, secrets),
    usage:
      result.usage === null || result.usage.model === null
        ? result.usage
        : { ...result.usage, model: redactText(result.usage.model, secrets) },
  };
}
