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
  /** The current GitHub login, refreshed on every sign in. */
  github_login: string;
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

export interface IntegrationsTable {
  id: string;
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

/** One setting of the whole instance (src/db/repositories/app-settings-repository.ts). */
export interface AppSettingsTable {
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
  /**
   * The platform's id of the comment a comment command came from, or null. Unique per repository
   * where not null: one job per comment.
   */
  comment_id: string | null;
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

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  sessions: SessionsTable;
  accounts: AccountsTable;
  verifications: VerificationsTable;
  allowed_login_pins: AllowedLoginPinsTable;
  integrations: IntegrationsTable;
  repositories: RepositoriesTable;
  projects: ProjectsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  jobs: JobsTable;
  app_settings: AppSettingsTable;
}
