// SPDX-License-Identifier: LicenseRef-Proprietary

// #499: the migrations of the monthly limit and the hidden brake: the table of the settings a workspace
// makes for itself, and the two indexes the claim's limit queries use.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { insertUser } from "../../test-support/users.ts";

const T = "2026-10-21T08:00:00.000Z";

for (const engine of BILLING_ENGINES) {
  describe(`the workspace billing settings table on ${engine.name}`, () => {
    // #499-T12
    it("keeps at most one row for a workspace, and only for a workspace that exists", async () => {
      const { db, workspaceId } = await engine.create();
      const row = (workspace: string) =>
        db
          .insertInto("billing_workspace_settings")
          .values({
            workspace_id: workspace,
            monthly_limit_micro_usd: 50_000_000,
            updated_by: null,
            updated_at: T,
          })
          .execute();

      await row(workspaceId);
      await expect(row(workspaceId)).rejects.toThrow(/unique|primary/i);
      await expect(row("missing")).rejects.toThrow();
    });

    // #499-T03
    it("stores no limit as null and refuses a limit that is not positive", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await db
        .insertInto("billing_workspace_settings")
        .values({
          workspace_id: workspaceId,
          monthly_limit_micro_usd: null,
          updated_by: null,
          updated_at: T,
        })
        .execute();
      const limit = (value: number) =>
        db
          .insertInto("billing_workspace_settings")
          .values({
            workspace_id: otherWorkspaceId,
            monthly_limit_micro_usd: value,
            updated_by: null,
            updated_at: T,
          })
          .execute();

      await expect(limit(0)).rejects.toThrow();
      await expect(limit(-5)).rejects.toThrow();
      // Above 2^31: a plain 32 bit column would fail here.
      await limit(3_000_000_000);
    });

    // #499-T04
    it("keeps the row when the user who set the limit is deleted", async () => {
      const { db, workspaceId } = await engine.create();
      await insertUser(db, { id: "owner-1" });
      await db
        .insertInto("billing_workspace_settings")
        .values({
          workspace_id: workspaceId,
          monthly_limit_micro_usd: 1_000_000,
          updated_by: "owner-1",
          updated_at: T,
        })
        .execute();
      await expect(
        db
          .updateTable("billing_workspace_settings")
          .set({ updated_by: "nobody" })
          .execute(),
      ).rejects.toThrow();

      await db.deleteFrom("users").where("id", "=", "owner-1").execute();

      const stored = await db
        .selectFrom("billing_workspace_settings")
        .select(["monthly_limit_micro_usd", "updated_by"])
        .executeTakeFirstOrThrow();
      expect(stored.updated_by).toBeNull();
      expect(Number(stored.monthly_limit_micro_usd)).toBe(1_000_000);
    });

    // #499-T05
    it("has an index on the workspace and the start time of a record, and one on the type and time of an entry", async () => {
      const { db } = await engine.create();
      const { rows: names } = await sql<{
        name: string;
      }>`select indexname as name from pg_indexes where tablename in ('usage_records', 'billing_journal_entries')`.execute(
        db,
      );
      expect(names.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "usage_records_workspace_reserved_at",
          "billing_journal_entries_type_created",
        ]),
      );
    });

    // #499-T14
    it("lets the month sum read the amount from the index alone", async () => {
      const { db } = await engine.create();
      const { rows } = await sql<{
        definition: string;
      }>`select indexdef as definition from pg_indexes where indexname = 'billing_journal_entries_type_created'`.execute(
        db,
      );
      const definition = rows[0]?.definition ?? "";

      expect(definition).toContain("amount_micro_usd");
      expect(definition).toContain("created_at");
    });
  });
}
