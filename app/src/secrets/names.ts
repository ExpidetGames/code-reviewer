// The secrets of the instance, by name (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.7: the SMTP password and the credentials of the GitHub App). The name is the row id of the
// `secrets` table and is bound into the ciphertext, so the list is closed: a feature that stores a
// new credential adds its name here. (Secrets of a workspace, such as its LLM key, are not here:
// they belong to a workspace and are stored with it.)
export const SECRET_NAMES = [
  "github_app_client_secret",
  "github_app_private_key",
  "github_app_webhook_secret",
  "smtp_password",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(value: unknown): value is SecretName {
  return SECRET_NAMES.some((name) => name === value);
}
