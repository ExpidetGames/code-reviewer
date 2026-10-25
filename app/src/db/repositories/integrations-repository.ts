// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the integrations table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts). The only code that reads or writes the table, together with the instance
// level directory (integration-directory-repository.ts) that webhooks and the sync need before a
// workspace is known.
import "server-only";
import type { Kysely } from "kysely";
import { findSecretLikeKeys } from "../../integrations/config-schema.ts";
import { IntegrationError } from "../../integrations/errors.ts";
import {
  INTEGRATION_SECRET_STORAGE,
  INTEGRATION_STATUSES,
  isIntegrationType,
  type Integration,
  type IntegrationStatus,
  type IntegrationType,
  type JsonValue,
} from "../../integrations/types.ts";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import type { Database, IntegrationsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type NewIntegration = {
  type: IntegrationType;
  displayName: string;
  /** The platform's id for the connection (GitHub App: the installation id). Required. */
  externalId: string;
  config: { [key: string]: JsonValue };
  /** Only for types that keep credentials in the table (none yet). */
  credentials?: JsonValue | null;
  /** Only for types with a webhook secret per integration (none yet). */
  webhookSecret?: string | null;
  status?: IntegrationStatus;
};

export type IntegrationsRepository = {
  /** Validates the secret rules of the type, then inserts. Never stores a secret in `config`. */
  create(input: NewIntegration): Promise<Integration>;
  get(id: string): Promise<Integration | undefined>;
  findByExternalId(
    type: IntegrationType,
    externalId: string,
  ): Promise<Integration | undefined>;
  list(): Promise<Integration[]>;
  setStatus(id: string, status: IntegrationStatus): Promise<void>;
  /** Replaces the display name and the config (for example after the account was renamed). */
  updateDetails(
    id: string,
    details: { displayName: string; config: { [key: string]: JsonValue } },
  ): Promise<void>;
};

export function toIntegration(row: IntegrationsTable): Integration {
  if (!isIntegrationType(row.type))
    throw new IntegrationError(
      "INTEGRATION_TYPE_UNKNOWN",
      `Stored integration ${row.id} has the unknown type "${row.type}".`,
    );
  const status = INTEGRATION_STATUSES.find((value) => value === row.status);
  if (status === undefined)
    throw new IntegrationError(
      "INTEGRATION_STATUS_INVALID",
      `Stored integration ${row.id} has the unknown status "${row.status}".`,
    );

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    displayName: row.display_name,
    externalId: row.external_id,
    config: decodeJson<{ [key: string]: JsonValue }>(row.config),
    credentials:
      row.credentials === null ? null : decodeJson<JsonValue>(row.credentials),
    webhookSecret: row.webhook_secret,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertStatus(status: unknown): asserts status is IntegrationStatus {
  if (!INTEGRATION_STATUSES.some((value) => value === status))
    throw new IntegrationError(
      "INTEGRATION_STATUS_INVALID",
      `Unknown integration status "${String(status)}".`,
    );
}

function assertNoSecretInConfig(config: { [key: string]: JsonValue }): void {
  // Names only, never values: the message must be safe to log.
  const suspicious = findSecretLikeKeys(config);
  if (suspicious.length > 0)
    throw new IntegrationError(
      "INTEGRATION_SECRET_NOT_ALLOWED",
      `The config must not hold secrets (offending keys: ${suspicious.join(", ")}).`,
    );
}

function assertValidInput(input: NewIntegration): void {
  if (!isIntegrationType(input.type))
    throw new IntegrationError(
      "INTEGRATION_TYPE_UNKNOWN",
      `Unknown integration type "${String(input.type)}".`,
    );
  if (typeof input.externalId !== "string" || input.externalId === "")
    throw new IntegrationError(
      "INTEGRATION_EXTERNAL_ID_REQUIRED",
      "An integration needs the platform's id for the connection.",
    );
  assertStatus(input.status ?? "active");

  const storage = INTEGRATION_SECRET_STORAGE[input.type];
  if (input.credentials != null && !storage.credentials)
    throw new IntegrationError(
      "INTEGRATION_SECRET_NOT_ALLOWED",
      `Integrations of type "${input.type}" do not store credentials.`,
    );
  if (input.webhookSecret != null && !storage.webhookSecret)
    throw new IntegrationError(
      "INTEGRATION_SECRET_NOT_ALLOWED",
      `Integrations of type "${input.type}" do not store a webhook secret.`,
    );

  assertNoSecretInConfig(input.config);
}

export function createIntegrationsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): IntegrationsRepository {
  async function get(id: string) {
    const row = await db
      .selectFrom("integrations")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toIntegration(row);
  }

  return {
    async create(input) {
      assertValidInput(input);

      const timestamp = formatTimestamp(now());
      const row: IntegrationsTable = {
        id: newId(),
        workspace_id: workspaceId,
        type: input.type,
        display_name: input.displayName,
        external_id: input.externalId,
        config: encodeJson(input.config),
        credentials:
          input.credentials == null ? null : encodeJson(input.credentials),
        webhook_secret: input.webhookSecret ?? null,
        status: input.status ?? "active",
        created_at: timestamp,
        updated_at: timestamp,
      };

      try {
        await db.insertInto("integrations").values(row).execute();
      } catch (cause) {
        if (errorCode(cause) === "SQLITE_CONSTRAINT_UNIQUE")
          throw new IntegrationError(
            "INTEGRATION_ALREADY_EXISTS",
            `An integration of type "${input.type}" with this external id exists already.`,
            { cause },
          );
        throw cause;
      }
      return toIntegration(row);
    },

    get,

    async findByExternalId(type, externalId) {
      const row = await db
        .selectFrom("integrations")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("type", "=", type)
        .where("external_id", "=", externalId)
        .executeTakeFirst();
      return row === undefined ? undefined : toIntegration(row);
    },

    async list() {
      const rows = await db
        .selectFrom("integrations")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toIntegration);
    },

    async setStatus(id, status) {
      assertStatus(status);
      const result = await db
        .updateTable("integrations")
        .set({ status, updated_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0)
        throw new IntegrationError(
          "INTEGRATION_NOT_FOUND",
          `No integration with id ${id}.`,
        );
    },

    async updateDetails(id, details) {
      assertNoSecretInConfig(details.config);
      const result = await db
        .updateTable("integrations")
        .set({
          display_name: details.displayName,
          config: encodeJson(details.config),
          updated_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0)
        throw new IntegrationError(
          "INTEGRATION_NOT_FOUND",
          `No integration with id ${id}.`,
        );
    },
  };
}
