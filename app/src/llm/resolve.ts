// SPDX-License-Identifier: Apache-2.0

// Which LLM access a job of a workspace gets (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.8). In this order, the first that applies wins:
//
//   1. the workspace's own key (BYOK), entered by an Owner or an Admin;
//   2. the operator's key, if the operator offers "included" usage (a stub that is OFF, for now: the pricing
//      phase fills it; `operator` is always null on the running server);
//   3. otherwise `llm_not_configured`.
//
// The legacy `LLM_PROVIDER` / `LLM_API_KEY` variables are not a step any more: the import of an existing
// installation (src/legacy-import/) moved the key into the default workspace once, and nothing reads the
// variables afterwards.
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
  type LlmAccess,
  type LlmAccessResult,
} from "./access.ts";
import { LLM_PROVIDERS, type LlmDefaults, type LlmProvider } from "./config.ts";

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
  /** The model and the context window the instance suggests (from `LLM_MODEL` and `LLM_MAX_TOKENS`). */
  defaults: Pick<LlmDefaults, "model" | "contextWindowTokens">;
};

function knownProvider(binding: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((provider) => provider === binding);
}

export function resolveWorkspaceLlmAccess(
  input: ResolveLlmInput,
): LlmAccessResult {
  const { key, operator, defaults } = input;
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

  return failure("no_key");
}
