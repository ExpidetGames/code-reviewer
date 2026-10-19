// SPDX-License-Identifier: Apache-2.0

// The LLM keys of ONE workspace (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.7 and 2.8; ADR
// 0005, section 2.5): what an Owner or an Admin enters in the workspace settings, "LLM access". There is one key per
// provider, each in its own slot of the encrypted store of the workspace (src/secrets/workspace-store.ts) under the
// name its adapter gives it (`llm_api_key` for the first provider, so a key stored before there were several providers is
// that provider's key, unchanged), bound to the provider it was entered for. A key of one provider is never read,
// replaced or removed by a call for another.
//
// - **Write-only.** The service answers whether a key is configured, cannot be read, or is missing, and the last
//   four characters of a long key. Nothing returns the key itself except `reveal`, for the claim of the runner
//   API and the test button, both on the server.
// - **An empty field keeps the stored key of that provider.** There is nothing to keep for a provider without a
//   key (`api_key_required`); a key is never carried over to another provider (the lesson of the SMTP password).
// - **The same rules as the legacy variable** (`checkLlmApiKey`): surrounding whitespace is ignored, whitespace
//   or control characters inside and more than 4096 characters are refused.
// - Who may do this is decided before the service is reached (`manage_llm_key`, an Admin or an Owner); the service
//   does not see roles.
import { checkLlmApiKey, type LlmProvider } from "./config.ts";
import { llmProviderDescriptors } from "./providers/index.ts";
import type { LlmProviderDescriptor } from "./providers/types.ts";
import type { WorkspaceSecretName } from "../secrets/names.ts";
import type { WorkspaceSecretStore } from "../secrets/workspace-store.ts";
import type { SecretValue } from "../secrets/secret-value.ts";
import type { WorkspaceKeyForJob } from "./resolve.ts";

export const LLM_KEY_ISSUE_CODES = [
  /** The provider is not one of the supported ones. */
  "provider_invalid",
  /** The key is not text, or has whitespace or control characters inside, or is too long. */
  "api_key_invalid",
  /** There is no key stored for this provider (or it cannot be read) and the field is empty. */
  "api_key_required",
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

/** The state of the key of one provider, for the card of that provider. */
export type ProviderKeyStatus = {
  /** The id of a registered provider. */
  provider: string;
  status: WorkspaceLlmKeyStatus;
};

/**
 * Every call names the provider whose slot it is about; a provider that is not registered has no slot (no key,
 * nothing to remove), it never falls back to another one.
 */
export type WorkspaceLlmKeyService = {
  status(provider: string): Promise<WorkspaceLlmKeyStatus>;
  /** The state of the key of every registered provider, in the order of the registry. */
  statusAll(): Promise<ProviderKeyStatus[]>;
  /** Saves the key of `input.provider`; the keys of the other providers are not touched. */
  save(
    input: SaveLlmKeyInput,
    updatedBy: string | null,
  ): Promise<SaveLlmKeyResult>;
  /** Removes the key of this provider only; false when there was none. */
  remove(provider: string): Promise<boolean>;
  /** The key, for code on the server that sends it to its provider. Never hand it to a response. */
  reveal(provider: string): Promise<RevealedLlmKey>;
  /** The key of this provider as the resolver (src/llm/resolve.ts) takes it. */
  keyFor(provider: string): Promise<WorkspaceKeyForJob>;
};

/** What the service and the assembly read of the registry: the providers the app supports, or a test's own. */
export type ProviderLookup = {
  readonly ids: readonly string[];
  find(raw: unknown): LlmProviderDescriptor | undefined;
};

export function createWorkspaceLlmKeyService({
  store,
  providers = llmProviderDescriptors,
}: {
  store: WorkspaceSecretStore;
  providers?: ProviderLookup;
}): WorkspaceLlmKeyService {
  // The slot of a provider: the name its adapter gave its workspace key. Registered names are validated when the
  // registry is built (they cannot collide), so the closed list of names is the registry's own list. A registry
  // of a test may have providers the types do not know, hence the two casts.
  const slotOfDescriptor = (descriptor: LlmProviderDescriptor) => ({
    id: descriptor.id as LlmProvider,
    name: descriptor.secretNames.workspace as WorkspaceSecretName,
  });
  // The slot a stored or computed provider id names, exactly: no trimming and no case folding.
  function slotOf(provider: string) {
    const found = providers.find(provider);
    return found?.id === provider ? slotOfDescriptor(found) : undefined;
  }

  async function status(provider: string): Promise<WorkspaceLlmKeyStatus> {
    const slot = slotOf(provider);
    if (slot === undefined) return { state: "not_configured" };
    const stored = await store.status(slot.name);
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

  async function reveal(provider: string): Promise<RevealedLlmKey> {
    const slot = slotOf(provider);
    if (slot === undefined) return { ok: false, reason: "no_key" };
    const used = await store.use(slot.name);
    if (!used.ok)
      return {
        ok: false,
        reason:
          used.error === "secret_not_configured" ? "no_key" : "key_unreadable",
      };
    // The key must have been entered for the provider of its slot.
    if (used.binding !== slot.id)
      return { ok: false, reason: "key_binding_mismatch" };
    return { ok: true, provider: slot.id, apiKey: used.value };
  }

  return {
    status,
    reveal,

    async statusAll() {
      return Promise.all(
        providers.ids.map(async (id) => ({
          provider: id,
          status: await status(id),
        })),
      );
    },

    async save(input, updatedBy) {
      const issues: LlmKeyIssue[] = [];
      // As the request had it: trimmed and in any case.
      const found = providers.find(input.provider);
      const slot = found === undefined ? undefined : slotOfDescriptor(found);
      if (slot === undefined)
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
      if (slot === undefined || issues.length > 0) return { ok: false, issues };

      if (apiKey === undefined) {
        const current = await status(slot.id);
        if (current.state !== "configured")
          return {
            ok: false,
            issues: [{ field: "apiKey", code: "api_key_required" }],
          };
        return { ok: true, status: current, changed: false };
      }

      const saved = await store.save(slot.name, apiKey, {
        binding: slot.id,
        updatedBy,
        showLastFour: true,
      });
      // The key passed the checks above, so the store has nothing to refuse; keep the answer honest anyway.
      if (!saved.ok)
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_invalid" }],
        };
      return { ok: true, status: await status(slot.id), changed: true };
    },

    async remove(provider) {
      const slot = slotOf(provider);
      return slot === undefined ? false : store.remove(slot.name);
    },

    async keyFor(provider) {
      const slot = slotOf(provider);
      if (slot === undefined) return { state: "none" };
      const used = await store.use(slot.name);
      if (!used.ok)
        return used.error === "secret_not_configured"
          ? { state: "none" }
          : { state: "unreadable" };
      // The resolver compares the binding with the provider it asked for before the key is used.
      return {
        state: "key",
        binding: used.binding,
        apiKey: used.value.reveal(),
      };
    },
  };
}
