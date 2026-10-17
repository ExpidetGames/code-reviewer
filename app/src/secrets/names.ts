// SPDX-License-Identifier: Apache-2.0

// The secrets of the instance, by name (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.7: the SMTP password, the credentials of the GitHub App and the operator's LLM keys). The name is the row id of the
// `secrets` table and is bound into the ciphertext, so the list is closed: a feature that stores a
// new credential adds its name here. (Secrets of a workspace, such as its LLM key, are not here:
// they belong to a workspace and are stored with it, see WORKSPACE_SECRET_NAMES below.)
import { llmProviderDescriptors } from "../llm/providers/index.ts";

/** The operator's LLM key of each provider, from the registry (src/llm/providers/). */
type OperatorLlmKeyName =
  (typeof llmProviderDescriptors.operatorSecretNames)[number];

const FIXED_SECRET_NAMES = [
  "github_app_client_secret",
  "github_app_private_key",
  "github_app_webhook_secret",
  "smtp_password",
] as const;

/**
 * Every secret of the instance, in alphabetical order. The LLM keys of the operator (used by the workspaces whose
 * key mode is `managed`, #276) are one per provider, named by the provider's adapter.
 */
export const SECRET_NAMES: readonly SecretName[] = [
  ...FIXED_SECRET_NAMES,
  ...llmProviderDescriptors.operatorSecretNames,
].sort();
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
  (typeof llmProviderDescriptors.workspaceSecretNames)[number];
