// SPDX-License-Identifier: Apache-2.0

// Which LLM access a job of a workspace gets (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.8). The workspace's key mode, from its entitlements (src/workspaces/entitlements.ts), decides whose key it
// is, and nothing else does:
//
//   - `own` (and a workspace without entitlements, which is the instance that never configured any): the
//     workspace's own key (BYOK), entered by an Owner or an Admin. The operator's key is never looked at;
//   - `managed`: the operator's own key, stored by the instance admin (src/llm/operator-key.ts). The
//     workspace's own key is ignored (it stays stored), and the workspace never falls back to it: the
//     entitlement says which key is used;
//   - entitlements that cannot be read: the job fails closed, because it is not known whose key applies.
//
// The legacy `LLM_PROVIDER` / `LLM_API_KEY` variables are not a step any more: the import of an existing
// installation (src/legacy-import/) moved the key into the default workspace once, and nothing reads the
// variables afterwards.
//
// Pure: the pieces are looked up by the caller (src/llm/assemble.ts), so the order is testable on its own. The
// input is a union on purpose: a job of a workspace that is not `managed` has no place to put the operator's
// key, and a managed one has no place for the workspace's, so neither can be borrowed by mistake.
//
// Every failure is closed. A workspace key that exists but cannot be read, one that was made for another
// provider than the one it would be sent to, an operator key that is missing or cannot be read: none of them
// falls through to another key. Using a different key instead would spend somebody else's money without
// anybody having decided it, and sending the key to another provider would hand a credential to a party it was
// not entered for.
import {
  createLlmAccess,
  LLM_NOT_CONFIGURED_ERROR,
  type LlmAccessResult,
  type LlmNotConfiguredReason,
} from "./access.ts";
import type { LlmDefaults, LlmProvider } from "./config.ts";
import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "./providers/index.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
  type KeyMode,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";

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

/** What the instance stored as the operator's key, as the resolver needs it. */
export type OperatorKeyForJob =
  | { state: "none" }
  | { state: "unreadable" }
  | { state: "key"; apiKey: string };

type Defaults = Pick<LlmDefaults, "model" | "contextWindowTokens">;

export type ResolveLlmInput =
  /** The workspace's own key. The operator's key has no place here. */
  | { keyMode: "own"; key: WorkspaceKeyForJob; defaults: Defaults }
  /** The operator's key. The workspace's own key has no place here. */
  | { keyMode: "managed"; operatorKey: OperatorKeyForJob; defaults: Defaults }
  /** The entitlements of the workspace cannot be read. */
  | { keyMode: "unreadable"; defaults: Defaults };

/** Whose key a job of a workspace with these entitlements uses; `unreadable` when that cannot be known. */
export function keyModeForJob(
  entitlements: ResolvedEntitlements,
): KeyMode | "unreadable" {
  if (entitlements.kind === "unlimited") return "own";
  if (entitlements.kind === "invalid") return "unreadable";
  return entitlements.keyMode;
}

function knownProvider(binding: string): LlmProvider | undefined {
  return llmProviderDescriptors.ids.find((provider) => provider === binding);
}

const failure = (reason: LlmNotConfiguredReason) =>
  ({
    ok: false,
    errorCode: LLM_NOT_CONFIGURED_ERROR,
    reason,
    issues: [],
  }) as const;

export function resolveWorkspaceLlmAccess(
  input: ResolveLlmInput,
): LlmAccessResult {
  const { defaults } = input;

  if (input.keyMode === "unreadable") return failure(ENTITLEMENTS_INVALID_CODE);

  if (input.keyMode === "managed") {
    const { operatorKey } = input;
    if (operatorKey.state === "unreadable")
      return failure("operator_key_unreadable");
    if (operatorKey.state === "none") return failure("operator_key_missing");
    return {
      ok: true,
      source: "operator",
      access: createLlmAccess({
        // The operator's key is not bound to a provider: it is the default provider's.
        provider: DEFAULT_LLM_PROVIDER,
        model: defaults.model,
        apiKey: operatorKey.apiKey,
        contextWindowTokens: defaults.contextWindowTokens,
      }),
    };
  }

  const { key } = input;
  if (key.state === "unreadable") return failure("key_unreadable");
  if (key.state === "none") return failure("no_key");
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
