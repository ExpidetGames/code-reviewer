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

export interface WebhookDeliveriesTable {
  /** The platform's delivery id (GitHub: `X-GitHub-Delivery`). */
  delivery_id: string;
  /** The event name of the delivery, for example "pull_request". */
  event: string;
  /** A WebhookDeliveryOutcome (src/db/repositories/webhook-deliveries-repository.ts). */
  outcome: string;
  /** ISO 8601 text in UTC: when the delivery was first accepted. */
  received_at: string;
}

export interface Database {
  app_meta: AppMetaTable;
  integrations: IntegrationsTable;
  repositories: RepositoriesTable;
  webhook_deliveries: WebhookDeliveriesTable;
}
