// SPDX-License-Identifier: LicenseRef-Proprietary

// How many workspaces hold a stored own LLM key (of any provider), shown to the instance admin who is about to switch billing
// on (#504): once billing is on, each workspace chooses its key mode itself (ADR 0006, D4), and one that holds a key of its
// own may use it. Instance level: it counts across workspaces, takes no argument and returns one number, no row and no name.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

export type OwnKeyCountRepository = {
  countWorkspacesWithStoredOwnKey(): Promise<number>;
};

/** `ownKeyNames`: the names a workspace's own LLM keys are stored under (the application knows them, the database does not). */
export function createOwnKeyCountRepository(
  db: Kysely<Database>,
  ownKeyNames: readonly string[],
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
        .where("name", "in", [...ownKeyNames])
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },
  };
}
