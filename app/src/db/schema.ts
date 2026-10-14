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
  /**
   * The verified primary email of the user's GitHub account when another account has it already, so an
   * imported user's placeholder address could not be replaced (src/github-signin/decide.ts); otherwise null.
   */
  email_conflict: string | null;
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

/** Which GitHub account a login on the allow list is bound to; used by the update to accounts (`src/legacy-import/`). */
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
  /**
   * A ProjectReviewKind (#195), 'diff' for PR-Agent and 'dynamic' for the read-only agent. The
   * database default is 'diff', so a row written without it (a migration, an older app instance) is a
   * Diff job.
   */
  review_kind: ColumnType<string, string | undefined, string>;
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

/** An encrypted credential of one workspace (src/db/repositories/workspace-secrets-repository.ts, src/secrets/). */
export interface WorkspaceSecretsTable {
  workspace_id: string;
  /** The secret's name (the field bound into the ciphertext), from WORKSPACE_SECRET_NAMES. */
  name: string;
  /** What the secret was made for (the provider of an LLM key); it must still match when it is used. */
  binding: string;
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

/**
 * What an operator allows one workspace (src/db/repositories/workspace-entitlements-repository.ts,
 * src/workspaces/entitlements.ts). One row per workspace; no row means the instance default or unlimited.
 */
export interface WorkspaceEntitlementsTable {
  /** The workspace; the primary key, so a workspace has at most one row. */
  workspace_id: string;
  /** A label for display and audit, at most 64 printable characters; the code never branches on it. */
  plan_label: string;
  /** `own` or `managed` (KEY_MODES). */
  key_mode: string;
  /** JSON text: `diffRunsPerPeriod`, `dynamicRunsPerPeriod`, `managedCostLimitMicroUsd`, each a count or null. */
  limits: string;
  /** ISO 8601 text in UTC: usage counts from here. Never moves to an earlier time. */
  period_start: string;
  /** 1 while the workspace's reviews are suspended, otherwise 0. */
  suspended: number;
  /** A short lowercase code that says why; null unless `suspended` is 1. */
  suspension_code: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
  /** The id of the user who saved it last, or null (the operator API, or a user who was deleted since). */
  updated_by: string | null;
}

/** The LLM key handed to a runner with the claim of a job, encrypted (src/runner-api/claimed-keys.ts). */
export interface JobClaimedKeysTable {
  job_id: string;
  /** The encrypted key followed by the authentication tag, base64. */
  ciphertext: string;
  /** The random 96-bit nonce, base64. */
  nonce: string;
  key_version: number;
  /** ISO 8601 text in UTC. */
  created_at: string;
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
 * The single-use side of a signed `state` that travels through the browser and GitHub (the manifest flow, the
 * authorization that links a GitHub identity); see src/signed-state/.
 */
export interface SignedStatesTable {
  /** The random nonce that the signed value names. */
  id: string;
  /** What the state is for (`github-manifest`, `github-link`): a state of one purpose is worthless for another. */
  purpose: string;
  /** The person who started it. */
  user_id: string | null;
  /** SHA-256 (hex) of the session it was started in: the callback must come from the same session. */
  session_hash: string | null;
  /** The PKCE verifier of an authorization started here; never leaves the server. */
  code_verifier: string | null;
  /** JSON text that belongs to the flow and comes back when the state is used (never a secret), or null. */
  data: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the state is unused. */
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

/**
 * A request to link a GitHub App installation that the instance admin decides, because the role of the
 * requester's GitHub account could not be read (src/installation-binding/). Keeps the evidence, never a token.
 */
export interface InstallationLinkRequestsTable {
  id: string;
  workspace_id: string;
  /** The user who asked, or null once the user is gone. */
  requested_by: string | null;
  /** The login of the GitHub account the requester proved control of, or null. */
  requester_github_login: string | null;
  /** The platform's id of the installation, as text. */
  installation_id: string;
  account_login: string;
  /** `User` or `Organization`, as GitHub says. */
  account_type: string;
  /** The numeric id of the installation's account, as text. */
  account_id: string;
  /** An InstallationLinkRequestStatus (src/installation-binding/requests.ts). */
  status: string;
  /** 1 when the requester's token lists the installation, 0 when it does not, null when it could not be asked. */
  token_can_access: number | null;
  /** A RoleResult (src/installation-binding/github-user.ts). */
  role_result: string;
  /** A stable code that says why the role could not be read, or null. */
  role_detail: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC, or null while the request is pending. */
  decided_at: string | null;
  decided_by: string | null;
}

/** An installation of the GitHub App that no workspace has linked (src/db/repositories/unclaimed-installations-repository.ts). */
export interface UnclaimedInstallationsTable {
  /** The platform's id of the installation, as text. */
  installation_id: string;
  account_login: string;
  account_type: string;
  /** ISO 8601 text in UTC. */
  first_seen_at: string;
  /** ISO 8601 text in UTC. */
  last_seen_at: string;
  /** `webhook` or `sync`. */
  source: string;
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
  workspace_secrets: WorkspaceSecretsTable;
  workspace_entitlements: WorkspaceEntitlementsTable;
  job_claimed_keys: JobClaimedKeysTable;
  password_reset_tokens: PasswordResetTokensTable;
  email_verification_tokens: EmailVerificationTokensTable;
  signed_states: SignedStatesTable;
  invitations: InvitationsTable;
  installation_link_requests: InstallationLinkRequestsTable;
  unclaimed_installations: UnclaimedInstallationsTable;
}
