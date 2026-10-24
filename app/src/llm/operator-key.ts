// SPDX-License-Identifier: LicenseRef-Proprietary

// The operator's own LLM keys (docs/decisions/0001-editions-setup-and-accounts.md, section 2.8, addendum; ADR 0005,
// section 2.5): the keys an instance admin stores for the workspaces whose key mode is `managed`
// (src/workspaces/entitlements.ts), one for each provider. Each lives in the encrypted secret store of the instance
// (src/secrets/), under the name its provider's adapter gives it (src/llm/providers/; `operator_llm_key` for the
// first provider, so a key stored before there were several is that provider's key, unchanged, and
// `operator_llm_key.<provider>` for the others). A key of one provider is never read, replaced or removed by a call
// for another, and a job that runs on a provider without a key never borrows another provider's.
//
// - **Write-only**, like every credential of the portal. The service answers whether a key is configured, cannot
//   be read, or is missing, and the last four characters of a long key. Nothing returns the key except `forJob`,
//   which hands it to the resolver (src/llm/resolve.ts) and to the key test of the portal, on the server.
// - **Only the instance admin writes it**, in the admin portal. It is not a setting of the operator API: whoever
//   holds that token must not hold the keys. This service is wired to the portal's service and to the resolver and
//   to nothing else.
// - **The provider is named exactly**: its id as the registry has it, with no trimming and no case folding. A name
//   that is not a registered provider has no slot (no key, nothing to remove, nothing to save).
// - The rules for a key are those of the workspace's key (`checkLlmApiKey`): surrounding whitespace is ignored,
//   whitespace or control characters inside and more than 4096 characters are refused.
import type { SecretName } from "../secrets/names.ts";
import type { SecretStore } from "../secrets/store.ts";
import { checkLlmApiKey } from "./config.ts";
import { llmProviderDescriptors } from "./providers/index.ts";
import type { OperatorKeyForJob } from "./resolve.ts";
import type { OperatorProviderLookup } from "./workspace-key.ts";

export const OPERATOR_KEY_ISSUE_CODES = [
  /** The provider is not one of the supported ones. */
  "provider_invalid",
  /** The key is not text, or has whitespace or control characters inside, or is too long. */
  "api_key_invalid",
  /** The field is empty: there is nothing to save. */
  "api_key_required",
  /** The Test button with an empty field found a saved key that cannot be decrypted (sealed with another master key). */
  "api_key_unreadable",
] as const;
export type OperatorKeyIssueCode = (typeof OPERATOR_KEY_ISSUE_CODES)[number];
export type OperatorKeyIssue = {
  field: "provider" | "apiKey";
  code: OperatorKeyIssueCode;
};

/** What the portal may know about the key. Never the key. */
export type OperatorLlmKeyStatus =
  | { state: "not_configured" }
  | {
      state: "configured";
      /** The last four characters of a long key, or null. */
      lastFour: string | null;
      updatedAt: string;
      updatedBy: string | null;
    }
  | { state: "unreadable"; updatedAt: string; updatedBy: string | null };

/** The state of the key of one provider, for the card of that provider. */
export type ProviderOperatorKeyStatus = {
  /** The id of a registered provider. */
  provider: string;
  status: OperatorLlmKeyStatus;
};

export type SaveOperatorKeyInput = {
  /** As the request had it; it must be a registered provider's id exactly. */
  provider: unknown;
  /** As the request had it; checked here. */
  apiKey: unknown;
};

export type SaveOperatorKeyResult =
  | { ok: true; status: OperatorLlmKeyStatus }
  | { ok: false; issues: OperatorKeyIssue[] };

/**
 * Every call names the provider whose slot it is about; a provider that is not registered has no slot, it never
 * falls back to another one.
 */
export type OperatorLlmKeyService = {
  status(provider: string): Promise<OperatorLlmKeyStatus>;
  /** The state of the key of every registered provider, in the order of the registry. */
  statusAll(): Promise<ProviderOperatorKeyStatus[]>;
  /** Saves the key of `input.provider`; the keys of the other providers are not touched. */
  save(
    input: SaveOperatorKeyInput,
    updatedBy: string | null,
  ): Promise<SaveOperatorKeyResult>;
  /** Removes the key of this provider only; false when there was none. */
  remove(provider: string): Promise<boolean>;
  /** The key of this provider as the resolver takes it. Never hand it to a response. */
  forJob(provider: string): Promise<OperatorKeyForJob>;
};

export function createOperatorLlmKeyService({
  store,
  providers = llmProviderDescriptors,
}: {
  store: Pick<SecretStore, "status" | "save" | "remove" | "use">;
  /** The providers the app supports; a test passes its own. */
  providers?: OperatorProviderLookup;
}): OperatorLlmKeyService {
  // The name a provider's operator key is stored under, for the id exactly: no trimming and no case folding. A
  // registry of a test may have providers the types do not know, hence the cast.
  function nameOf(provider: unknown): SecretName | undefined {
    if (typeof provider !== "string") return undefined;
    const found = providers.find(provider);
    return found?.id === provider
      ? (found.secretNames.operator as SecretName)
      : undefined;
  }

  async function status(provider: string): Promise<OperatorLlmKeyStatus> {
    const name = nameOf(provider);
    if (name === undefined) return { state: "not_configured" };
    const stored = await store.status(name);
    switch (stored.state) {
      case "not_configured":
        return { state: "not_configured" };
      case "configured":
        return {
          state: "configured",
          lastFour: stored.lastFour,
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
      case "undecryptable":
        return {
          state: "unreadable",
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
        };
    }
  }

  return {
    status,

    async statusAll() {
      return Promise.all(
        providers.ids.map(async (id) => ({
          provider: id,
          status: await status(id),
        })),
      );
    },

    async save(input, updatedBy) {
      const name = nameOf(input.provider);
      if (name === undefined)
        return {
          ok: false,
          issues: [{ field: "provider", code: "provider_invalid" }],
        };
      const { apiKey } = input;
      if (
        apiKey === undefined ||
        apiKey === null ||
        (typeof apiKey === "string" && apiKey.trim() === "")
      )
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_required" }],
        };
      const checked =
        typeof apiKey === "string" ? checkLlmApiKey(apiKey) : undefined;
      if (checked === undefined || !checked.ok)
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_invalid" }],
        };

      const saved = await store.save(name, checked.key, {
        updatedBy,
        showLastFour: true,
      });
      // The key passed the checks above, so the store has nothing to refuse; keep the answer honest anyway.
      if (!saved.ok)
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_invalid" }],
        };
      return { ok: true, status: await status(input.provider as string) };
    },

    async remove(provider) {
      const name = nameOf(provider);
      return name === undefined ? false : store.remove(name);
    },

    async forJob(provider) {
      const name = nameOf(provider);
      if (name === undefined) return { state: "none" };
      const used = await store.use(name);
      if (used.ok) return { state: "key", apiKey: used.value.reveal() };
      return used.error === "secret_not_configured"
        ? { state: "none" }
        : { state: "unreadable" };
    },
  };
}
