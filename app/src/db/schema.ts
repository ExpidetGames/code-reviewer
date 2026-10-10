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

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  sessions: SessionsTable;
  accounts: AccountsTable;
  verifications: VerificationsTable;
}
