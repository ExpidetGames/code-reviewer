// SPDX-License-Identifier: Apache-2.0

// The integrations table seen from outside every workspace. INSTANCE LEVEL, on purpose: a webhook
// names an installation before anybody knows which workspace it belongs to, and the synchronization
// walks every connection of the instance. Both only read; the answer carries `workspaceId`, and
// everything they do next goes through repositories created for that workspace. Writing integrations
// is the job of integrations-repository.ts, which is always scoped.
import "server-only";
import type { Kysely } from "kysely";
import type { Integration, IntegrationType } from "../../integrations/types.ts";
import type { Database } from "../schema.ts";
import { toIntegration } from "./integrations-repository.ts";

export type IntegrationDirectory = {
  /** The integration of a connection as the platform names it, whatever its workspace. */
  findByExternalId(
    type: IntegrationType,
    externalId: string,
  ): Promise<Integration | undefined>;
  /** Every integration of the instance, oldest first. */
  list(): Promise<Integration[]>;
  get(id: string): Promise<Integration | undefined>;
};

export function createIntegrationDirectory(
  db: Kysely<Database>,
): IntegrationDirectory {
  return {
    async findByExternalId(type, externalId) {
      const row = await db
        .selectFrom("integrations")
        .selectAll()
        .where("type", "=", type)
        .where("external_id", "=", externalId)
        .executeTakeFirst();
      return row === undefined ? undefined : toIntegration(row);
    },

    async list() {
      const rows = await db
        .selectFrom("integrations")
        .selectAll()
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toIntegration);
    },

    async get(id) {
      const row = await db
        .selectFrom("integrations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toIntegration(row);
    },
  };
}
