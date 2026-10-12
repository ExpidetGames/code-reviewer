// SPDX-License-Identifier: Apache-2.0

// Which LLM access a job of a workspace gets (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.8). In this order, the first that applies wins:
//
//   1. the workspace's own key (BYOK), entered by an Owner or an Admin;
//   2. the operator's key, if the operator offers "included" usage (a stub that is OFF, for now: the pricing
//      phase fills it; `operator` is always null on the running server);
//   3. the legacy `LLM_*` variables, until the import of an existing installation moves them into the default
//      workspace (#106). Only on a single-tenant instance, where "the instance" and "the workspace" are the
//      same thing: on a multi-tenant instance a shared key from the environment would be spent by every
//      workspace that has not brought its own, which the decision record does not intend (a workspace without
//      a key fails with `llm_not_configured`);
//   4. otherwise `llm_not_configured`.
//
// Pure: the pieces are looked up by the caller (src/llm/shared.ts), so the order is testable on its own.
//
// Two cases fail closed instead of falling through to the next step: a workspace key that exists but cannot
// be read, and one that was made for another provider than the one it would be sent to. Using a different key
// instead would spend somebody else's money without anybody having decided it, and sending the key to another
// provider would hand a credential to a party it was not entered for.
import {
  createLlmAccess,
  LLM_NOT_CONFIGURED_ERROR,
  resolveLlmAccess,
  type LlmAccess,
  type LlmAccessResult,
} from "./access.ts";
import {
  LLM_PROVIDERS,
  type LlmConfigState,
  type LlmDefaults,
  type LlmProvider,
} from "./config.ts";

/** What the workspace has stored, as the resolver needs it. */
export type WorkspaceKeyForJob =
  | { state: "none" }
  | { state: "unreadable" }
  | {
      state: "key";
      /** What the key was made for, as stored. */
      binding: string;
      apiKey: string;
    };

export type ResolveLlmInput = {
  key: WorkspaceKeyForJob;
  /** The operator's access when "included" usage is offered; null while it is not (always, for now). */
  operator: LlmAccess | null;
  environment: {
    /** True on a single-tenant instance only (see the header). */
    allowed: boolean;
    state: LlmConfigState;
  };
  /** The model and the context window the instance suggests (from `LLM_MODEL` and `LLM_MAX_TOKENS`). */
  defaults: Pick<LlmDefaults, "model" | "contextWindowTokens">;
};

function knownProvider(binding: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((provider) => provider === binding);
}

export function resolveWorkspaceLlmAccess(
  input: ResolveLlmInput,
): LlmAccessResult {
  const { key, operator, environment, defaults } = input;
  const failure = (
    reason: "no_key" | "key_unreadable" | "key_binding_mismatch",
  ) =>
    ({
      ok: false,
      errorCode: LLM_NOT_CONFIGURED_ERROR,
      reason,
      issues: [],
    }) as const;

  if (key.state === "unreadable") return failure("key_unreadable");
  if (key.state === "key") {
    const provider = knownProvider(key.binding);
    if (provider === undefined) return failure("key_binding_mismatch");
    return {
      ok: true,
      source: "workspace",
      access: createLlmAccess({
        provider,
        model: defaults.model,
        apiKey: key.apiKey,
        contextWindowTokens: defaults.contextWindowTokens,
      }),
    };
  }

  if (operator !== null)
    return { ok: true, source: "operator", access: operator };

  if (environment.allowed) {
    const legacy = resolveLlmAccess(environment.state);
    if (legacy.ok) return legacy;
    // A legacy configuration that is simply absent (neither the provider nor the key is set) is "no key"; one
    // that is set but wrong, or half set, is reported as such (names and codes of the variables only).
    const absent =
      legacy.issues.length === 2 &&
      legacy.issues.some((issue) => issue.code === "LLM_API_KEY_MISSING") &&
      legacy.issues.some((issue) => issue.code === "LLM_PROVIDER_MISSING");
    return absent ? failure("no_key") : legacy;
  }
  return failure("no_key");
}
