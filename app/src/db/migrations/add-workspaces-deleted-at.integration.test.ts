// SPDX-License-Identifier: Apache-2.0

// #658: the migration that marks a deleted workspace, on SQLite and on Postgres. A workspace row is made without the column
// (null: not deleted), and the reason for a tombstone instead of a delete is pinned: a workspace with a journal entry cannot
// be removed, because the journal is append-only and points at it.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../repositories/billing-journal-repository.ts";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the deleted_at column of workspaces on ${engine.name}`,
    () => {
      it("is null for a workspace that was made without it", async () => {
        const { db, workspaceId } = await engine.create();

        const row = await db
          .selectFrom("workspaces")
          .select("deleted_at")
          .where("id", "=", workspaceId)
          .executeTakeFirstOrThrow();

        expect(row.deleted_at).toBeNull();
      });

      it("is the reason a workspace with a billing journal is anonymised and not removed", async () => {
        const { db, workspaceId } = await engine.create();
        await createBillingJournalRepository(db, workspaceId).append({
          type: "top_up",
          amountMicroUsd: 10_000_000,
          refKey: "payment-1",
        });

        await expect(
          db.deleteFrom("workspaces").where("id", "=", workspaceId).execute(),
        ).rejects.toThrow();
      });
    },
  );
}
