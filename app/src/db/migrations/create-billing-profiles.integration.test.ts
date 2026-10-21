// SPDX-License-Identifier: Apache-2.0

// #501: the migration of the billing profile, on SQLite and on Postgres. One row per workspace, nothing else is touched.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { insertUser } from "../../test-support/users.ts";

const T = "2026-10-21T08:00:00.000Z";

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the billing profile table on ${engine.name}`,
    () => {
      // #501-T11
      it("keeps at most one profile for a workspace, and only for a workspace that exists", async () => {
        const { db, workspaceId } = await engine.create();
        const profile = (workspace: string) =>
          db
            .insertInto("billing_profiles")
            .values({
              workspace_id: workspace,
              legal_name: "Example GmbH",
              country: "DE",
              address_line1: "Teststrasse 1",
              address_line2: null,
              postal_code: "10115",
              city: "Berlin",
              vat_id: null,
              created_at: T,
              updated_at: T,
            })
            .execute();

        await profile(workspaceId);
        await expect(profile(workspaceId)).rejects.toThrow(/unique|primary/i);
        await expect(profile("missing")).rejects.toThrow();
      });

      // #501-T03
      it("holds the time and the terms version of the confirmation together, and the confirming user as a user", async () => {
        const { db, workspaceId } = await engine.create();
        await insertUser(db, { id: "buyer" });
        await db
          .insertInto("billing_profiles")
          .values({
            workspace_id: workspaceId,
            legal_name: "Example GmbH",
            country: "DE",
            address_line1: "Teststrasse 1",
            address_line2: null,
            postal_code: "10115",
            city: "Berlin",
            vat_id: null,
            created_at: T,
            updated_at: T,
          })
          .execute();
        const confirm = (values: Record<string, unknown>) =>
          db
            .updateTable("billing_profiles")
            .set(values)
            .where("workspace_id", "=", workspaceId)
            .execute();

        await expect(confirm({ confirmed_at: T })).rejects.toThrow();
        await expect(confirm({ terms_version: "1" })).rejects.toThrow();
        await expect(
          confirm({
            confirmed_at: T,
            terms_version: "1",
            confirmed_by: "nobody",
          }),
        ).rejects.toThrow();
        await confirm({
          confirmed_at: T,
          terms_version: "1",
          confirmed_by: "buyer",
        });
      });

      // #501-T09
      it("has the columns of a profile and a customer reference, and no payload", async () => {
        const { db } = await engine.create();
        const columns = await sql<{ name: string }>`
        select column_name as name from information_schema.columns where table_name = 'billing_profiles'`
          .execute(db)
          .then((result) => result.rows)
          .catch(
            async () =>
              (
                await sql<{
                  name: string;
                }>`select name from pragma_table_info('billing_profiles')`.execute(
                  db,
                )
              ).rows,
          );
        expect(columns.map((column) => column.name).sort()).toEqual(
          [
            "address_line1",
            "address_line2",
            "city",
            "confirmed_at",
            "confirmed_by",
            "country",
            "created_at",
            "customer_adapter",
            "customer_ref",
            "legal_name",
            "postal_code",
            "terms_version",
            "updated_at",
            "vat_id",
            "workspace_id",
          ].sort(),
        );
      });
    },
  );
}
