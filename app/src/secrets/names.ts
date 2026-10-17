// SPDX-License-Identifier: Apache-2.0

// The secrets of the instance, by name (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.7: the SMTP password, the credentials of the GitHub App and the operator's LLM key). The name is the row id of the
// `secrets` table and is bound into the ciphertext, so the list is closed: a feature that stores a
// new credential adds its name here. (Secrets of a workspace, such as its LLM key, are not here:
// they belong to a workspace and are stored with it, see WORKSPACE_SECRET_NAMES below.)
export const SECRET_NAMES = [
  "github_app_client_secret",
  "github_app_private_key",
  "github_app_webhook_secret",
  /** The LLM key of the instance's operator, used by the workspaces whose key mode is `managed` (#276). */
  "operator_llm_key",
  /** The Paddle API key of the billing module (ADR 0005, M11; #437). */
  "paddle_api_key",
  /** The signing secret of the Paddle notification destination (ADR 0005, M11; #437). */
  "paddle_webhook_secret",
  "smtp_password",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(value: unknown): value is SecretName {
  return SECRET_NAMES.some((name) => name === value);
}

/**
 * The secrets of ONE workspace, by name (section 2.7 and 2.8: the workspace's own LLM key). The name is the
 * field that is bound into the ciphertext, together with the table and the workspace id, so the list is closed.
 */
export const WORKSPACE_SECRET_NAMES = ["llm_api_key"] as const;
export type WorkspaceSecretName = (typeof WORKSPACE_SECRET_NAMES)[number];
