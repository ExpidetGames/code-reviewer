// SPDX-License-Identifier: Apache-2.0

// What a job gets from the shared LLM configuration, and how a missing configuration is reported.
//
// The claim of the runner API calls `resolveLlmAccess` once per claim, with the environment as it is
// at that moment (so a key that is fixed while the app runs is used by the next claim). A
// configuration that does not work fails the job with `llm_not_configured`; the job is not handed to
// the runner and not retried, because nothing a retry does can fix an environment variable.
import {
  createLlmConfig,
  type LlmConfig,
  type LlmConfigIssue,
} from "./config.ts";

/** The job error code of a claim that found no usable LLM configuration. */
export const LLM_NOT_CONFIGURED_ERROR = "llm_not_configured" as const;

/**
 * The LLM part of a job: the same value as the configuration (`apiKey` is readable but not
 * enumerable: JSON, spreads, entries and console output leave it out). Only `revealLlmAccess` hands
 * the key out, for the runner API's claim response.
 */
export type LlmAccess = LlmConfig;

/** Where the access of a job comes from (src/llm/resolve.ts, docs/decisions/0001-..., section 2.8). */
export const LLM_ACCESS_SOURCES = [
  /** The key the workspace entered itself (BYOK). */
  "workspace",
  /** The operator's own key: the workspace's key mode is `managed` (src/workspaces/entitlements.ts). */
  "operator",
] as const;
export type LlmAccessSource = (typeof LLM_ACCESS_SOURCES)[number];

/** Why no access could be made. A stable code for the log and the UI, never a value. */
export const LLM_NOT_CONFIGURED_REASONS = [
  /** The workspace has no key and nothing else applies. */
  "no_key",
  /** The workspace's key is stored but cannot be read (another APP_SECRET, or a changed row). */
  "key_unreadable",
  /** The workspace's key was made for another provider than the one it would be sent to. */
  "key_binding_mismatch",
  /** The workspace's key mode is `managed` and the operator has stored no key. */
  "operator_key_missing",
  /** The workspace's key mode is `managed` and the operator's key is stored but cannot be read. */
  "operator_key_unreadable",
  /** The entitlements of the workspace cannot be read, so it is not known whose key applies. */
  "entitlements_invalid",
] as const;
export type LlmNotConfiguredReason =
  (typeof LLM_NOT_CONFIGURED_REASONS)[number];

export type LlmAccessResult =
  | { ok: true; access: LlmAccess; source: LlmAccessSource }
  | {
      ok: false;
      errorCode: typeof LLM_NOT_CONFIGURED_ERROR;
      reason: LlmNotConfiguredReason;
      /** Which variables are wrong. Names and codes only, never a value. */
      issues: readonly LlmConfigIssue[];
    };

/**
 * What the pages know about a workspace whose access is not its own key (#276). `provided`: the instance's key
 * serves it (the key mode is `managed`). `key_unavailable`: it is `managed` and the instance has no usable key.
 * `settings_unreadable`: the entitlements cannot be read, so it is not known whose key applies; the jobs fail
 * closed. Null: an ordinary workspace with its own key, whether it has one or not.
 */
export type InstanceAccess =
  "provided" | "key_unavailable" | "settings_unreadable";

export function instanceAccessOf(
  summary:
    | { configured: true; source: LlmAccessSource }
    | { configured: false; reason: LlmNotConfiguredReason },
): InstanceAccess | null {
  if (summary.configured)
    return summary.source === "operator" ? "provided" : null;
  switch (summary.reason) {
    case "operator_key_missing":
    case "operator_key_unreadable":
      return "key_unavailable";
    case "entitlements_invalid":
      return "settings_unreadable";
    default:
      return null;
  }
}

export const createLlmAccess = createLlmConfig;

/** Stable codes of `LlmAccessError`. */
export const LLM_ACCESS_ERROR_CODES = ["LLM_ACCESS_HAS_NO_KEY"] as const;
export type LlmAccessErrorCode = (typeof LLM_ACCESS_ERROR_CODES)[number];

export class LlmAccessError extends Error {
  readonly code: LlmAccessErrorCode;
  /** The message names the code's meaning only, never a value. */
  readonly safeMessage = true as const;

  constructor(code: LlmAccessErrorCode, message: string) {
    super(message);
    this.name = "LlmAccessError";
    this.code = code;
  }
}

/**
 * A plain copy with the key included, for the one place that must send it on. Calling it is a
 * deliberate act; do not log, store or return its result to a browser. Throws
 * `LLM_ACCESS_HAS_NO_KEY` when there is no key, so a broken access is never sent to a runner as if
 * it were usable (the claim fails the job instead).
 */
export function revealLlmAccess(access: LlmAccess): LlmAccess {
  if (typeof access.apiKey !== "string" || access.apiKey === "")
    throw new LlmAccessError(
      "LLM_ACCESS_HAS_NO_KEY",
      "The LLM access has no key to hand out.",
    );
  return {
    provider: access.provider,
    model: access.model,
    apiKey: access.apiKey,
    contextWindowTokens: access.contextWindowTokens,
  };
}

const MASK = "[redacted]";

// The forms a secret takes in an error text besides the plain one: percent-encoded (in a URL),
// escaped for JSON (in a logged body) and base64 (in an `Authorization: Basic` header or a dump).
function forms(secret: string): string[] {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const base64 = Buffer.from(secret, "utf8").toString("base64");
  return [
    ...new Set([secret, encodeURIComponent(secret), jsonEscaped, base64]),
  ];
}

/**
 * Replaces the secrets in a text with a mask, in the plain, percent-encoded, JSON-escaped and base64
 * form: for example an error text a runner reports. Empty secrets are ignored. **Best effort**: a
 * secret that was cut, split or transformed in some other way is not found. Pass every key that may
 * be in the text: the key *handed out with the claim* of the job (it may have been rotated since)
 * and the current one.
 */
export function maskSecretInText(text: string, ...secrets: string[]): string {
  let masked = text;
  // Longest first, so a secret that contains another one is masked as a whole.
  const all = secrets
    .filter((secret) => secret !== "")
    .flatMap(forms)
    .sort((a, b) => b.length - a.length);
  for (const form of all) masked = masked.split(form).join(MASK);
  return masked;
}
