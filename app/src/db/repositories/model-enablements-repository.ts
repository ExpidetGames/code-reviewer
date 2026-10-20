// SPDX-License-Identifier: Apache-2.0

// Whether the admin enabled a catalog model for the managed key (#549, src/model-prices/README.md). Instance level: this is
// configuration of the installation, not customer data, and no workspace owns a row. One row per model, changed in place;
// no row means the admin has not decided (and `clear` takes a decision back). The row refers to the catalog's model row, which is never deleted.
import "server-only";
import type { Kysely } from "kysely";
import { decodeBoolean, encodeBoolean, formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type ModelEnablement = {
  providerId: string;
  modelId: string;
  enabled: boolean;
  /** The user who made the last change, or null. */
  changedBy: string | null;
  changedAt: string;
};

export type ModelEnablementsRepository = {
  get(
    providerId: string,
    modelId: string,
  ): Promise<ModelEnablement | undefined>;
  list(): Promise<ModelEnablement[]>;
  /** The models that are enabled: what the fetch guard watches (#548). */
  listEnabled(): Promise<Array<{ providerId: string; modelId: string }>>;
  /** Makes or changes the decision. Fails for a model the catalog does not have. */
  set(
    input: {
      providerId: string;
      modelId: string;
      enabled: boolean;
      changedBy: string | null;
    },
    at: Date,
  ): Promise<ModelEnablement>;
  /** Takes the decision back, so the model has none again ("new", when it was first seen after the first fetch). True when there was one. */
  clear(providerId: string, modelId: string): Promise<boolean>;
};

type Row = {
  provider_id: string;
  model_id: string;
  enabled: number;
  changed_by: string | null;
  changed_at: string;
};

function enablementOf(row: Row): ModelEnablement {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    enabled: decodeBoolean(row.enabled),
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

export function createModelEnablementsRepository(
  db: Kysely<Database>,
): ModelEnablementsRepository {
  return {
    async get(providerId, modelId) {
      const row = await db
        .selectFrom("model_enablements")
        .selectAll()
        .where("provider_id", "=", providerId)
        .where("model_id", "=", modelId)
        .executeTakeFirst();
      return row === undefined ? undefined : enablementOf(row);
    },

    async list() {
      const rows = await db
        .selectFrom("model_enablements")
        .selectAll()
        .orderBy("provider_id")
        .orderBy("model_id")
        .execute();
      return rows.map(enablementOf);
    },

    async listEnabled() {
      const rows = await db
        .selectFrom("model_enablements")
        .select(["provider_id", "model_id"])
        .where("enabled", "=", 1)
        .execute();
      return rows.map((row) => ({
        providerId: row.provider_id,
        modelId: row.model_id,
      }));
    },

    async set(input, at) {
      const values = {
        enabled: encodeBoolean(input.enabled),
        changed_by: input.changedBy,
        changed_at: formatTimestamp(at),
      };
      const row = await db
        .insertInto("model_enablements")
        .values({
          provider_id: input.providerId,
          model_id: input.modelId,
          ...values,
        })
        .onConflict((conflict) =>
          conflict.columns(["provider_id", "model_id"]).doUpdateSet(values),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return enablementOf(row);
    },

    async clear(providerId, modelId) {
      const result = await db
        .deleteFrom("model_enablements")
        .where("provider_id", "=", providerId)
        .where("model_id", "=", modelId)
        .executeTakeFirst();
      return result.numDeletedRows > BigInt(0);
    },
  };
}
