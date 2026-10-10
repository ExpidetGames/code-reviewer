// Row types of every table, the single place Kysely learns the schema from. Add a table here in the
// same change as the migration that creates it. Column conventions: see README.md in this folder.

export interface AppMetaTable {
  key: string;
  value: string;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

export interface IntegrationsTable {
  id: string;
  /** An IntegrationType (src/integrations/types.ts). */
  type: string;
  display_name: string;
  /** The platform's id for the connection, for example a GitHub installation id. */
  external_id: string | null;
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

export interface Database {
  app_meta: AppMetaTable;
  integrations: IntegrationsTable;
}
