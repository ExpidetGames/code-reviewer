// SPDX-License-Identifier: Apache-2.0

// How many workspaces hold a stored own LLM key and have no entitlements row of the operator: the workspaces
// that stop reviewing on their own key once billing is on (ADR 0005, M19), shown to the instance admin before they
// switch billing on (#437). Instance level: it counts across workspaces, reads two tables and returns one number.
// Until billing writes entitlements of its own (a `source` marker, a later issue of epic #421) every row of
// `workspace_entitlements` is the operator's, so "no manual row" is "no row".
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

export type OwnKeyCountRepository = {
  countWorkspacesWithStoredOwnKey(): Promise<number>;
};

export function createOwnKeyCountRepository(
  db: Kysely<Database>,
): OwnKeyCountRepository {
  return {
    async countWorkspacesWithStoredOwnKey() {
      const row = await db
        .selectFrom("workspace_secrets")
        .select((builder) =>
          builder.fn
            .count<string | number>("workspace_id")
            .distinct()
            .as("count"),
        )
        .where("name", "=", "llm_api_key")
        .where((builder) =>
          builder.not(
            builder.exists(
              builder
                .selectFrom("workspace_entitlements")
                .select("workspace_id")
                .whereRef(
                  "workspace_entitlements.workspace_id",
                  "=",
                  "workspace_secrets.workspace_id",
                ),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },
  };
}
