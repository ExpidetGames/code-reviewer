// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: the migration of the balance notifications: one row for each workspace and kind (`low` or
// `empty`), its state (`armed` or `sent`) and the state of the mail that goes with a crossing.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";

const T = "2026-10-21T08:00:00.000Z";

for (const engine of BILLING_ENGINES) {
  describe(`the billing notifications table on ${engine.name}`, () => {
    const row = (
      workspace: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      workspace_id: workspace,
      kind: "low",
      state: "armed",
      sent_at: null,
      delivery: "none",
      updated_at: T,
      ...overrides,
    });

    // #506-T09
    it("keeps one row for a workspace and a kind, and only for a workspace that exists", async () => {
      const { db, workspaceId } = await engine.create();
      const insert = (workspace: string, kind: string) =>
        db
          .insertInto("billing_notifications")
          .values(row(workspace, { kind }) as never)
          .execute();

      await insert(workspaceId, "low");
      await insert(workspaceId, "empty");
      await expect(insert(workspaceId, "low")).rejects.toThrow(
        /unique|primary/i,
      );
      await expect(insert("missing", "low")).rejects.toThrow();
    });

    // #506-T09
    it("refuses a kind, a state or a delivery state it does not know", async () => {
      const { db, workspaceId } = await engine.create();
      const insert = (overrides: Record<string, unknown>) =>
        db
          .insertInto("billing_notifications")
          .values(row(workspaceId, overrides) as never)
          .execute();

      await expect(insert({ kind: "high" })).rejects.toThrow();
      await expect(insert({ state: "pending" })).rejects.toThrow();
      await expect(insert({ delivery: "queued" })).rejects.toThrow();
      await insert({});
      for (const delivery of ["none", "due", "sending", "delivered", "failed"])
        await db
          .updateTable("billing_notifications")
          .set({ delivery } as never)
          .execute();
      await expect(
        db
          .updateTable("billing_notifications")
          .set({ state: "sent", sent_at: null } as never)
          .execute(),
      ).resolves.toBeDefined();
    });

    // #506-T09
    it("has an index of the mails that are due", async () => {
      const { db } = await engine.create();
      const { rows: names } = await sql<{
        name: string;
      }>`select indexname as name from pg_indexes where tablename = 'billing_notifications'`.execute(
        db,
      );
      expect(names.map((index) => index.name)).toContain(
        "billing_notifications_due",
      );
    });
  });
}
