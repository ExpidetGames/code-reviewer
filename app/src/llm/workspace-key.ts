// SPDX-License-Identifier: Apache-2.0

// The LLM key of ONE workspace (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.7 and 2.8): what an
// Owner or an Admin enters in the workspace settings, "LLM access". The key lives only in the encrypted store of
// the workspace (src/secrets/workspace-store.ts), bound to the provider it was entered for.
//
// - **Write-only.** The service answers whether a key is configured, cannot be read, or is missing, and the last
//   four characters of a long key. Nothing returns the key itself except `reveal`, for the claim of the runner
//   API and the test button, both on the server.
// - **An empty field keeps the stored key.** That is only allowed while the provider is unchanged: a key is never
//   carried over to another provider (the lesson of the SMTP password, which is not carried over to another
//   host). Changing the provider asks for the key again (`api_key_required_for_new_provider`).
// - **The same rules as the legacy variable** (`checkLlmApiKey`): surrounding whitespace is ignored, whitespace
//   or control characters inside and more than 4096 characters are refused.
// - Who may do this is decided before the service is reached (`manage_llm_key`, an Admin or an Owner); the service
//   does not see roles.
import { checkLlmApiKey, LLM_PROVIDERS, type LlmProvider } from "./config.ts";
import type { WorkspaceSecretStore } from "../secrets/workspace-store.ts";
import type { SecretValue } from "../secrets/secret-value.ts";
import type { WorkspaceKeyForJob } from "./resolve.ts";

export const LLM_KEY_ISSUE_CODES = [
  /** The provider is not one of the supported ones. */
  "provider_invalid",
  /** The key is not text, or has whitespace or control characters inside, or is too long. */
  "api_key_invalid",
  /** There is no key stored (or it cannot be read) and the field is empty. */
  "api_key_required",
  /** The provider changed, so the stored key is not carried over: enter the key again. */
  "api_key_required_for_new_provider",
] as const;
export type LlmKeyIssueCode = (typeof LLM_KEY_ISSUE_CODES)[number];
export type LlmKeyIssue = {
  field: "provider" | "apiKey";
  code: LlmKeyIssueCode;
};

/** What the settings page may know about the key. Never the key. */
export type WorkspaceLlmKeyStatus =
  | { state: "not_configured" }
  | {
      state: "configured";
      /** What the key was entered for (a provider name). */
      provider: string;
      /** The last four characters of a long key, or null. */
      lastFour: string | null;
      updatedAt: string;
      updatedBy: string | null;
    }
  | {
      state: "unreadable";
      provider: string;
      updatedAt: string;
      updatedBy: string | null;
    };

export type SaveLlmKeyInput = {
  /** As the request had it; checked here. */
  provider: unknown;
  /** As the request had it; empty or missing keeps the stored key (while the provider is unchanged). */
  apiKey: unknown;
};

export type SaveLlmKeyResult =
  | { ok: true; status: WorkspaceLlmKeyStatus; changed: boolean }
  | { ok: false; issues: LlmKeyIssue[] };

export type RevealedLlmKey =
  | { ok: true; provider: LlmProvider; apiKey: SecretValue }
  | {
      ok: false;
      reason: "no_key" | "key_unreadable" | "key_binding_mismatch";
    };

export type WorkspaceLlmKeyService = {
  status(): Promise<WorkspaceLlmKeyStatus>;
  save(
    input: SaveLlmKeyInput,
    updatedBy: string | null,
  ): Promise<SaveLlmKeyResult>;
  /** Removes the key; false when there was none. */
  remove(): Promise<boolean>;
  /** The key, for code on the server that sends it to its provider. Never hand it to a response. */
  reveal(): Promise<RevealedLlmKey>;
  /** The key as the resolver (src/llm/resolve.ts) takes it. */
  forJob(): Promise<WorkspaceKeyForJob>;
};

const NAME = "llm_api_key" as const;

function providerOf(raw: unknown): LlmProvider | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return LLM_PROVIDERS.find((provider) => provider === value);
}

export function createWorkspaceLlmKeyService({
  store,
}: {
  store: WorkspaceSecretStore;
}): WorkspaceLlmKeyService {
  async function status(): Promise<WorkspaceLlmKeyStatus> {
    const stored = await store.status(NAME);
    switch (stored.state) {
      case "not_configured":
        return { state: "not_configured" };
      case "configured":
        return {
          state: "configured",
          provider: stored.binding,
          lastFour: stored.lastFour,
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
      case "undecryptable":
        return {
          state: "unreadable",
          provider: stored.binding,
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
    }
  }

  async function reveal(): Promise<RevealedLlmKey> {
    const used = await store.use(NAME);
    if (!used.ok)
      return {
        ok: false,
        reason:
          used.error === "secret_not_configured" ? "no_key" : "key_unreadable",
      };
    const provider = LLM_PROVIDERS.find((known) => known === used.binding);
    if (provider === undefined)
      return { ok: false, reason: "key_binding_mismatch" };
    return { ok: true, provider, apiKey: used.value };
  }

  return {
    status,
    reveal,

    async save(input, updatedBy) {
      const issues: LlmKeyIssue[] = [];
      const provider = providerOf(input.provider);
      if (provider === undefined)
        issues.push({ field: "provider", code: "provider_invalid" });

      // An empty field means "keep what is stored".
      const empty =
        input.apiKey === undefined ||
        input.apiKey === null ||
        (typeof input.apiKey === "string" && input.apiKey.trim() === "");
      let apiKey: string | undefined;
      if (!empty) {
        const checked =
          typeof input.apiKey === "string"
            ? checkLlmApiKey(input.apiKey)
            : { ok: false as const };
        if (checked.ok) apiKey = checked.key;
        else issues.push({ field: "apiKey", code: "api_key_invalid" });
      }
      if (provider === undefined || issues.length > 0)
        return { ok: false, issues };

      if (apiKey === undefined) {
        const current = await status();
        if (current.state !== "configured")
          return {
            ok: false,
            issues: [{ field: "apiKey", code: "api_key_required" }],
          };
        // The stored key was made for another provider: it is not carried over to this one.
        if (current.provider !== provider)
          return {
            ok: false,
            issues: [
              { field: "apiKey", code: "api_key_required_for_new_provider" },
            ],
          };
        return { ok: true, status: current, changed: false };
      }

      const saved = await store.save(NAME, apiKey, {
        binding: provider,
        updatedBy,
        showLastFour: true,
      });
      // The key passed the checks above, so the store has nothing to refuse; keep the answer honest anyway.
      if (!saved.ok)
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_invalid" }],
        };
      return { ok: true, status: await status(), changed: true };
    },

    remove: () => store.remove(NAME),

    async forJob() {
      const used = await store.use(NAME);
      if (!used.ok)
        return used.error === "secret_not_configured"
          ? { state: "none" }
          : { state: "unreadable" };
      // The resolver compares the binding with the providers it knows before the key is used.
      return {
        state: "key",
        binding: used.binding,
        apiKey: used.value.reveal(),
      };
    },
  };
}
