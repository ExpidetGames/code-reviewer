// SPDX-License-Identifier: Apache-2.0

import type { ColumnType } from "kysely";

// Row types of every table, the single place Kysely learns the schema from. Add a table here in the
// same change as the migration that creates it. Column conventions: see README.md in this folder.

export interface AppMetaTable {
  key: string;
  value: string;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

// The four tables below belong to Better Auth: it reads and writes them through its Kysely adapter
// (src/auth/auth.ts), so they have no repository. Nothing else in the app writes to them.
export interface UsersTable {
  id: string;
  name: string;
  email: string;
  /** 1 or 0. */
  email_verified: number;
  image: string | null;
  /** The current GitHub login, refreshed on every sign in. Null for a user without a GitHub account. */
  github_login: string | null;
  /**
   * When the user was imported from an installation that existed before accounts (ISO 8601, UTC), or
   * null. Set by the import only; only imported users qualify for the merge with the instance admin.
   */
  imported_at: string | null;
  /**
   * 1 for the instance admin (the account the first-run setup creates), otherwise 0. The database
   * fills in 0, so an insert (Better Auth's, a test's) may leave it out.
   */
  is_instance_admin: ColumnType<number, number | undefined, number>;
  /** When the membership in the allowed GitHub organization was last confirmed (ISO 8601, UTC), or null. */
  org_checked_at: string | null;
  /** The GitHub organization that check was made for, or null. */
  org_checked_for: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  id: string;
  expires_at: string;
  token: string;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
}

export interface AccountsTable {
  id: string;
  /** The identity at the provider: the numeric GitHub id, as text. */
  account_id: string;
  provider_id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  scope: string | null;
  password: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationsTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Which GitHub account a login on the allow list is bound to (src/auth/login-pins.ts). */
export interface AllowedLoginPinsTable {
  /** The lower-cased GitHub login. */
  login: string;
  /** The numeric GitHub id, as text. */
  github_id: string;
  /** ISO 8601 text in UTC. */
  pinned_at: string;
}

/** The owner of customer data (src/workspaces/README.md). */
export interface WorkspacesTable {
  id: string;
  name: string;
  /** Unique. */
  slug: string;
  /** The user who created it, or null (made by a migration or the setup). */
  created_by: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
}

/** A user's membership of a workspace, with a role (a WorkspaceRole, src/workspaces/roles.ts). */
export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
}

export interface IntegrationsTable {
  id: string;
  /** The workspace the connection belongs to; one installation is linked to one workspace only. */
  workspace_id: string;
  /** An IntegrationType (src/integrations/types.ts). */
  type: string;
  display_name: string;
  /** The platform's id for the connection, for example a GitHub installation id. */
  external_id: string;
  /** JSON text: settings only, never a secret. */
  config: string;
  /** JSON text, reserved for token integrations. Null for a GitHub App. */
  credentials: string | null;
  webhook_secret: string | null;
  /** An IntegrationStatus. */
  status: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

export interface RepositoriesTable {
  id: string;
  /** The workspace of the integration, repeated here so queries need no join. */
  workspace_id: string;
  /** The integration (for a GitHub App: the installation) that gives access to the repository. */
  integration_id: string;
  /** The platform's id of the repository. */
  external_id: string;
  /** "owner/name". */
  full_name: string;
  url: string;
  /** 1 while the platform still lists the repository for the integration, 0 once it does not. */
  active: number;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

export interface ProjectsTable {
  id: string;
  /** The repository this project reviews; unique, so a repository has at most one project. */
  repository_id: string;
  /** 1 while the project is switched on, 0 after it was deactivated. */
  active: number;
  /** JSON text: the project's setting overrides, '{}' until some are saved. */
  settings: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

/** One setting of a workspace (src/db/repositories/app-settings-repository.ts). */
export interface AppSettingsTable {
  workspace_id: string;
  /** The name of the setting, for example "review_defaults". */
  key: string;
  /** JSON text. */
  value: string;
  /** ISO 8601 text in UTC. */
  updated_at: string;
  /** The GitHub login of the person who saved it last, or null. */
  updated_by: string | null;
}

export interface WebhookDeliveriesTable {
  /** The platform's delivery id (GitHub: `X-GitHub-Delivery`). */
  delivery_id: string;
  /** The event name of the delivery, for example "pull_request". */
  event: string;
  /** A WebhookDeliveryOutcome (src/db/repositories/webhook-deliveries-repository.ts). */
  outcome: string;
  /** Random value of the request that owns the claim; only its owner may complete or release it. */
  claim_token: string;
  /** ISO 8601 text in UTC: when the current claim was made. */
  received_at: string;
}

export interface JobsTable {
  id: string;
  /** The workspace of the repository, repeated here so queries need no join. */
  workspace_id: string;
  repository_id: string;
  pr_number: number;
  pr_url: string;
  /** 40 hexadecimal characters, lower case. */
  head_sha: string;
  /** A ReviewCommand (src/integrations/types.ts). */
  command: string;
  /** Text after the command, an empty string when there is none. Untrusted. */
  args: string;
  /** A JobTriggerKind (src/jobs/job-types.ts). */
  trigger_kind: string;
  actor_login: string;
  /** The webhook delivery that created the job, or null. Unique where not null. */
  delivery_id: string | null;
  /** A JobStatus (src/jobs/job-status.ts). */
  status: string;
  /** ISO 8601 text in UTC: the job is not handed out before this moment. */
  run_after: string;
  /** How many attempts were lost (a lease ran out, a claim was given back). */
  attempts: number;
  runner_id: string | null;
  /**
   * Random value of the current claim; required to heartbeat, complete or release the job. Cleared
   * when the job is requeued, kept on a finished job so that a repeated report is recognised.
   */
  lease_token: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  /** JSON text, or null. */
  result: string | null;
  error_code: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** A comment that was answered with a job (src/jobs/README.md). One row per comment. */
export interface JobCommentsTable {
  repository_id: string;
  /** The platform's id of the comment, as text. */
  comment_id: string;
  /** The job that answers the comment; possibly one that was already waiting or running. */
  job_id: string;
}

/** One setting of the whole instance, with a JSON value (src/db/repositories/instance-settings-repository.ts). */
export interface InstanceSettingsTable {
  key: string;
  /** JSON text. */
  value: string;
  /** The id of the user who saved it last, or null. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/** A shared counter with a window (src/db/repositories/rate-limits-repository.ts). */
export interface RateLimitsTable {
  key: string;
  /** ISO 8601 text in UTC: when the current window began. */
  window_started_at: string;
  count: number;
}

/** An encrypted credential of the instance (src/db/repositories/secrets-repository.ts, src/secrets/). */
export interface SecretsTable {
  /** The secret's name; the row id that is bound into the ciphertext. */
  name: string;
  /** The encrypted value followed by the authentication tag, base64. */
  ciphertext: string;
  /** The random 96-bit nonce, base64. */
  nonce: string;
  /** The version of the derived key that encrypted it. */
  key_version: number;
  /** The last four characters of the value when the caller asked for the hint (not a secret), or null. */
  last_four: string | null;
  /** The id of the user who saved it last, or null. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/** A single-use link to set a new password; only the hash of the token is kept (src/auth/password-reset.ts). */
export interface PasswordResetTokensTable {
  /** SHA-256 of the token, hex. */
  token_hash: string;
  user_id: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the token is unused. */
  used_at: string | null;
}

/** A single-use link that verifies an email address; only the hash of the token is kept (src/signup/). */
export interface EmailVerificationTokensTable {
  /** SHA-256 of the token, hex. */
  token_hash: string;
  user_id: string;
  /** The address the link verifies; it verifies nothing once the account has another address. */
  email: string;
  /**
   * The password hash (Better Auth's format) of the sign-up that made the link. The link is used with that
   * password, and that hash becomes the password of the account.
   */
  password_hash: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the token is unused. */
  used_at: string | null;
}

/**
 * A single-use link that brings a person into a workspace; only the hash of the token is kept
 * (src/workspaces/invitations.ts).
 */
export interface InvitationsTable {
  id: string;
  workspace_id: string;
  /** The address the invitation is bound to, canonical (src/signup/rule.ts `canonicalEmail`). */
  email: string;
  /** The role the person gets (a WorkspaceRole, src/workspaces/roles.ts). */
  role: string;
  /** SHA-256 of the token, hex. A resend replaces it, which invalidates the old link. */
  token_hash: string;
  /** The user who created it, or null (the user is gone). */
  invited_by: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the invitation is pending or was revoked. */
  accepted_at: string | null;
  accepted_by: string | null;
  /** ISO 8601 text in UTC, or null while the invitation is pending or was accepted. */
  revoked_at: string | null;
}

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  sessions: SessionsTable;
  accounts: AccountsTable;
  verifications: VerificationsTable;
  allowed_login_pins: AllowedLoginPinsTable;
  workspaces: WorkspacesTable;
  workspace_members: WorkspaceMembersTable;
  integrations: IntegrationsTable;
  repositories: RepositoriesTable;
  projects: ProjectsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  jobs: JobsTable;
  job_comments: JobCommentsTable;
  app_settings: AppSettingsTable;
  instance_settings: InstanceSettingsTable;
  rate_limits: RateLimitsTable;
  secrets: SecretsTable;
  password_reset_tokens: PasswordResetTokensTable;
  email_verification_tokens: EmailVerificationTokensTable;
  invitations: InvitationsTable;
}
