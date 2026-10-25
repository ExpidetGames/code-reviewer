// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the tables created by our migrations are the tables Better Auth expects. Better
// Auth names the tables and fields its configuration needs; after our migrations every one of them
// must exist as a column. An upgrade of Better Auth, or a change of its configuration, that needs a new
// column fails here, and the fix is a new migration of ours, never a step run at start-up.
import { getAuthTables } from "better-auth/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createAuthHarness } from "../test-support/auth-harness.ts";

describe("the tables Better Auth needs", () => {
  it("are all created by our migrations, with nothing left for Better Auth to add", async () => {
    const harness = await createAuthHarness();
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'`.execute(harness.db);
    const columns = new Set(
      rows.map((row) => `${row.table_name}.${row.column_name}`),
    );

    const missing: string[] = [];
    for (const table of Object.values(getAuthTables(harness.auth.options))) {
      for (const [key, field] of Object.entries(table.fields)) {
        const column = `${table.modelName}.${field.fieldName ?? key}`;
        if (!columns.has(column)) missing.push(column);
      }
    }

    expect(missing).toEqual([]);
  });
});
