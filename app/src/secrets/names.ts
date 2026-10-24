// SPDX-License-Identifier: LicenseRef-Proprietary

// The secrets of the instance, by name (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.7: the SMTP password, the credentials of the GitHub App and the operator's LLM keys). The name is the row id of the
// `secrets` table and is bound into the ciphertext, so the list is closed: a feature that stores a
// new credential adds its name here. (Secrets of a workspace, such as its LLM key, are not here:
// they belong to a workspace and are stored with it, see WORKSPACE_SECRET_NAMES below.)
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { ProviderRegistryError } from "../llm/providers/registry.ts";
import type { NativeKeySecretName } from "../native-providers/lookup.ts";

/** The operator's LLM key of each provider, from the registry (src/llm/providers/). */
type OperatorLlmKeyName =
  (typeof llmProviderDescriptors.operatorSecretNames)[number];

export const FIXED_SECRET_NAMES = [
  "github_app_client_secret",
  "github_app_private_key",
  "github_app_webhook_secret",
  "smtp_password",
  // The Stripe credentials of the billing module (ADR 0006, 2.14; #500): the API key and the signing secret of the
  // webhook endpoint. Encrypted and write-only like the others; the admin form that sets them is #504.
  "stripe_api_key",
  "stripe_webhook_secret",
] as const;

/**
 * Every secret of the instance, in alphabetical order: the fixed names and the operator's LLM key of each provider
 * (used by the workspaces whose key mode is `managed`, #276), named by the provider's adapter. A provider name that
 * is a fixed name, or that another provider already uses, would put two secrets under one row id: that stops the app at
 * start (`ProviderRegistryError`), like any other invalid adapter.
 */
export function secretNamesOf(
  operatorLlmKeyNames: readonly string[],
): readonly SecretName[] {
  const taken = new Set<string>(FIXED_SECRET_NAMES);
  for (const name of operatorLlmKeyNames) {
    if (taken.has(name))
      throw new ProviderRegistryError(
        "provider_secret_name_taken",
        `operator key name "${name}" is already a secret name of the instance`,
      );
    taken.add(name);
  }
  return [...taken].sort() as SecretName[];
}

export const SECRET_NAMES: readonly SecretName[] = secretNamesOf(
  llmProviderDescriptors.operatorSecretNames,
);
export type SecretName =
  (typeof FIXED_SECRET_NAMES)[number] | OperatorLlmKeyName;

export function isSecretName(value: unknown): value is SecretName {
  return SECRET_NAMES.some((name) => name === value);
}

/**
 * The secrets of ONE workspace, by name (section 2.7 and 2.8: the workspace's own LLM key). The name is the
 * field that is bound into the ciphertext, together with the table and the workspace id, so the list is closed.
 * The names come from the provider registry.
 */
export const WORKSPACE_SECRET_NAMES: readonly WorkspaceSecretName[] =
  llmProviderDescriptors.workspaceSecretNames;
export type WorkspaceSecretName =
  | (typeof llmProviderDescriptors.workspaceSecretNames)[number]
  /**
   * The key of a catalog provider (#555), `llm_api_key.<slug>`. Those names are not a closed list: the providers are data
   * (`contracts/opencode-providers.v1.json`), so the slot is named after the slug and the store accepts any slug.
   */
  | NativeKeySecretName;
