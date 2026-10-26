// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: the currency of the amount the buyer was charged is pinned on the top-up intent next to it, so a refund or dispute in
// another currency is not taken for a share of the payment. The column is new and nullable and no row is touched: an intent
// written before it reads as "no currency pinned", and the version that is still running keeps working on the same
// database.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261021190000_add_billing_topup_intents_provider_currency";
const T = "2026-10-21T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = Kysely<Database>;

async function seedPaidIntent(db: Db) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'w-1', 'w-1', null, ${T})`.execute(
    db,
  );
  await sql`insert into billing_topup_intents (id, workspace_id, adapter, amount_micro_usd, state, credited_micro_usd, provider_payment_ref, created_at, updated_at) values ('i-1', 'w-1', 'stripe', 25000000, 'paid', 25000000, 'pi_1', ${T}, ${T})`.execute(
    db,
  );
}

async function currencyOf(db: Db): Promise<unknown> {
  const { rows } = await sql<{
    state: string;
    provider_currency: string | null;
  }>`select state, provider_currency from billing_topup_intents where id = 'i-1'`.execute(
    db,
  );
  return rows;
}

describe("the pinned provider currency of a top-up intent", () => {
  // #502-T16
  it("is added on Postgres, leaves an existing intent without a currency and stores one", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPaidIntent(db);

    await migrateToLatest(db);

    expect(await currencyOf(db)).toEqual([
      { state: "paid", provider_currency: null },
    ]);
    await sql`update billing_topup_intents set provider_currency = 'eur' where id = 'i-1'`.execute(
      db,
    );
    expect(await currencyOf(db)).toEqual([
      { state: "paid", provider_currency: "eur" },
    ]);
  });
});
