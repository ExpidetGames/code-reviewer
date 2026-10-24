// SPDX-License-Identifier: LicenseRef-Proprietary

// Which workspaces have a billing journal (#626), for the scheduled check of the journal (src/billing/journal-check.ts). Instance
// level on purpose, like the other sweeps: it asks across workspaces, only reads and returns workspace ids and nothing else; what is
// checked then goes through the journal repository of each workspace. A workspace is listed when it has a balance row or a journal
// entry, so a workspace whose cache row is missing is found as well.
//
// The ids come in order, a page after the last one of the previous page, and each page reads at most `limit` ids of each source (the
// primary key of the balances, the unique key of the journal): the cost of a page never grows with the length of a journal.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";

export type BillingJournalDirectory = {
  /** The ids greater than `after` (`""` for the first page), ascending, at most `limit` of them. */
  workspaceIdsAfter(after: string, limit: number): Promise<string[]>;
};

export function createBillingJournalDirectory(
  db: Kysely<Database>,
): BillingJournalDirectory {
  return {
    async workspaceIdsAfter(after, limit) {
      const { rows } = await sql<{ workspace_id: string }>`
        select workspace_id from (
          select workspace_id from (
            select workspace_id from billing_balances
            where workspace_id > ${after}
            order by workspace_id
            limit ${limit}
          ) as balances
          union
          select workspace_id from (
            select workspace_id from billing_journal_entries
            where workspace_id > ${after}
            group by workspace_id
            order by workspace_id
            limit ${limit}
          ) as entries
        ) as ids
        order by workspace_id
        limit ${limit}`.execute(db);
      return rows.map((row) => row.workspace_id);
    },
  };
}
