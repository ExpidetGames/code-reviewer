// SPDX-License-Identifier: Apache-2.0

// The operator's own LLM key (docs/decisions/0001-editions-setup-and-accounts.md, section 2.8, addendum): the one
// key an instance admin stores for the workspaces whose key mode is `managed` (src/workspaces/entitlements.ts).
// It lives in the encrypted secret store of the instance (src/secrets/), under the name the default provider's
// adapter gives it (src/llm/providers/; `operator_llm_key` for the built-in provider).
//
// - **Write-only**, like every credential of the portal. The service answers whether a key is configured, cannot
//   be read, or is missing, and the last four characters of a long key. Nothing returns the key except `forJob`,
//   which hands it to the resolver (src/llm/resolve.ts) on the server.
// - **Only the instance admin writes it**, in the admin portal. It is not a setting of the operator API: whoever
//   holds that token must not hold the key. This service is wired to the portal's service and to the resolver and
//   to nothing else.
// - **The provider is the default provider**, the only one for now, so the key is not bound to one.
// - The rules for a key are those of the workspace's key (`checkLlmApiKey`): surrounding whitespace is ignored,
//   whitespace or control characters inside and more than 4096 characters are refused.
import type { SecretStore } from "../secrets/store.ts";
import { checkLlmApiKey } from "./config.ts";
import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "./providers/index.ts";
import type { OperatorKeyForJob } from "./resolve.ts";

export const OPERATOR_KEY_ISSUE_CODES = [
  /** The key is not text, or has whitespace or control characters inside, or is too long. */
  "api_key_invalid",
  /** The field is empty: there is nothing to save. */
  "api_key_required",
] as const;
export type OperatorKeyIssueCode = (typeof OPERATOR_KEY_ISSUE_CODES)[number];
export type OperatorKeyIssue = { field: "apiKey"; code: OperatorKeyIssueCode };

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

export type SaveOperatorKeyResult =
  | { ok: true; status: OperatorLlmKeyStatus }
  | { ok: false; issues: OperatorKeyIssue[] };

export type OperatorLlmKeyService = {
  status(): Promise<OperatorLlmKeyStatus>;
  /** `input.apiKey` is the request's value, as received; checked here. */
  save(
    input: { apiKey: unknown },
    updatedBy: string | null,
  ): Promise<SaveOperatorKeyResult>;
  /** Removes the key; false when there was none. */
  remove(): Promise<boolean>;
  /** The key as the resolver takes it. Never hand it to a response. */
  forJob(): Promise<OperatorKeyForJob>;
};

const NAME =
  llmProviderDescriptors.get(DEFAULT_LLM_PROVIDER).secretNames.operator;

export function createOperatorLlmKeyService({
  store,
}: {
  store: Pick<SecretStore, "status" | "save" | "remove" | "use">;
}): OperatorLlmKeyService {
  async function status(): Promise<OperatorLlmKeyStatus> {
    const stored = await store.status(NAME);
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

    async save(input, updatedBy) {
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

      const saved = await store.save(NAME, checked.key, {
        updatedBy,
        showLastFour: true,
      });
      // The key passed the checks above, so the store has nothing to refuse; keep the answer honest anyway.
      if (!saved.ok)
        return {
          ok: false,
          issues: [{ field: "apiKey", code: "api_key_invalid" }],
        };
      return { ok: true, status: await status() };
    },

    remove: () => store.remove(NAME),

    async forJob() {
      const used = await store.use(NAME);
      if (used.ok) return { state: "key", apiKey: used.value.reveal() };
      return used.error === "secret_not_configured"
        ? { state: "none" }
        : { state: "unreadable" };
    },
  };
}
