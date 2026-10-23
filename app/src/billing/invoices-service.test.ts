// SPDX-License-Identifier: Apache-2.0

// #659: the role check of the invoices service stands on its own. The route resolves the role first (invoices-http.integration.test.ts);
// this is the second lock, for a caller that reaches the service without that check.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import type { BillingAdapter } from "./adapter.ts";
import { createInvoicesService } from "./invoices-service.ts";

/** A database and an adapter that fail the test the moment the service touches them. */
function untouchable() {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(`db.${String(property)}`);
        throw new Error("the database was read");
      },
    },
  ) as unknown as Kysely<Database>;
  const adapter = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(`adapter.${String(property)}`);
        throw new Error("the adapter was asked");
      },
    },
  ) as unknown as BillingAdapter;
  return { db, adapter, touched };
}

describe("the role check of the invoices service", () => {
  // #659-T03
  it("refuses a Member before it reads a profile or asks the provider, and logs the refusal once", async () => {
    const { db, adapter, touched } = untouchable();
    const logs: string[] = [];
    const service = createInvoicesService({
      db,
      activeAdapter: () => Promise.resolve(adapter),
      log: (line) => logs.push(line),
    });

    const result = await service.list({
      workspaceId: "ws-1",
      userId: "u-1",
      role: "member",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(touched).toEqual([]);
    expect(logs).toEqual([
      "[billing] INVOICES_LISTED workspace=ws-1 result=forbidden",
    ]);
  });
});
