// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the repositories table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts). The only code that reads or writes it. A repository is never
// deleted: when the platform stops listing it, it becomes inactive, and it becomes active again
// (same row) if it comes back.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { RepoRef } from "../../integrations/types.ts";
import { decodeBoolean, encodeBoolean, formatTimestamp } from "../codecs.ts";
import { IntegrationError } from "../../integrations/errors.ts";
import type { Database, RepositoriesTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** A repository as stored: a RepoRef plus the row's identity and its active flag. */
export type StoredRepository = {
  id: string;
  integrationId: string;
  externalId: string;
  fullName: string;
  url: string;
  /** False once the platform no longer lists the repository for its integration. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ReconcileResult = {
  /** Rows created for repositories seen for the first time. */
  added: number;
  /** Rows that were inactive and are active again. */
  reactivated: number;
  /** Active rows whose name or URL changed on the platform. */
  updated: number;
  /** Active rows the platform no longer lists, now inactive. */
  deactivated: number;
  unchanged: number;
};

export type RepositoriesRepository = {
  list(filter?: {
    integrationId?: string;
    active?: boolean;
  }): Promise<StoredRepository[]>;
  get(id: string): Promise<StoredRepository | undefined>;
  /** The row for a repository as the platform names it (its id within one integration). */
  findByExternalId(
    integrationId: string,
    externalId: string,
  ): Promise<StoredRepository | undefined>;
  /**
   * Makes the rows of one integration match the full list the platform gave: adds new repositories,
   * follows renames, reactivates returning ones and deactivates missing ones, in one transaction.
   * `remote` must be the complete list: pass it only when every page was read.
   */
  reconcile(integrationId: string, remote: RepoRef[]): Promise<ReconcileResult>;
  /** Marks all active repositories of an integration inactive (it was uninstalled); returns how many. */
  deactivateAll(integrationId: string): Promise<number>;
};

function toStored(row: RepositoriesTable): StoredRepository {
  return {
    id: row.id,
    integrationId: row.integration_id,
    externalId: row.external_id,
    fullName: row.full_name,
    url: row.url,
    active: decodeBoolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRepositoriesRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): RepositoriesRepository {
  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  return {
    async list(filter = {}) {
      let query = db
        .selectFrom("repositories")
        .selectAll()
        .where("workspace_id", "=", workspaceId);
      if (filter.integrationId !== undefined)
        query = query.where("integration_id", "=", filter.integrationId);
      if (filter.active !== undefined)
        query = query.where("active", "=", encodeBoolean(filter.active));
      const rows = await query
        .orderBy("created_at")
        // Case-insensitive, with the id as the tie-breaker: names that differ only by case keep a stable place.
        .orderBy(sql`lower(full_name)`)
        .orderBy("id")
        .execute();
      return rows.map(toStored);
    },

    async get(id) {
      const row = await db
        .selectFrom("repositories")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async findByExternalId(integrationId, externalId) {
      const row = await db
        .selectFrom("repositories")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("integration_id", "=", integrationId)
        .where("external_id", "=", externalId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    reconcile(integrationId, remote) {
      // The platform may list a repository twice while pages shift; the last entry wins.
      const wanted = new Map<string, RepoRef>();
      for (const repo of remote) wanted.set(repo.externalId, repo);

      return inTransaction(async (trx) => {
        // An integration of another workspace is not there for this one.
        const integration = await trx
          .selectFrom("integrations")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", integrationId)
          .executeTakeFirst();
        if (integration === undefined)
          throw new IntegrationError(
            "INTEGRATION_NOT_FOUND",
            `No integration with id ${integrationId}.`,
          );
        const timestamp = formatTimestamp(now());
        const existing = new Map(
          (
            await trx
              .selectFrom("repositories")
              .selectAll()
              .where("workspace_id", "=", workspaceId)
              .where("integration_id", "=", integrationId)
              .execute()
          ).map((row) => [row.external_id, row]),
        );
        const result: ReconcileResult = {
          added: 0,
          reactivated: 0,
          updated: 0,
          deactivated: 0,
          unchanged: 0,
        };

        for (const repo of wanted.values()) {
          const row = existing.get(repo.externalId);
          if (row === undefined) {
            await trx
              .insertInto("repositories")
              .values({
                id: newId(),
                workspace_id: workspaceId,
                integration_id: integrationId,
                external_id: repo.externalId,
                full_name: repo.fullName,
                url: repo.url,
                active: encodeBoolean(true),
                created_at: timestamp,
                updated_at: timestamp,
              })
              .execute();
            result.added += 1;
            continue;
          }

          const wasInactive = decodeBoolean(row.active) === false;
          const changed =
            row.full_name !== repo.fullName || row.url !== repo.url;
          if (!wasInactive && !changed) {
            result.unchanged += 1;
            continue;
          }
          await trx
            .updateTable("repositories")
            .set({
              full_name: repo.fullName,
              url: repo.url,
              active: encodeBoolean(true),
              updated_at: timestamp,
            })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", row.id)
            .execute();
          if (wasInactive) result.reactivated += 1;
          else result.updated += 1;
        }

        for (const [externalId, row] of existing) {
          if (wanted.has(externalId) || decodeBoolean(row.active) === false)
            continue;
          await trx
            .updateTable("repositories")
            .set({ active: encodeBoolean(false), updated_at: timestamp })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", row.id)
            .execute();
          result.deactivated += 1;
        }
        return result;
      });
    },

    async deactivateAll(integrationId) {
      const result = await db
        .updateTable("repositories")
        .set({
          active: encodeBoolean(false),
          updated_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("integration_id", "=", integrationId)
        .where("active", "=", encodeBoolean(true))
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
