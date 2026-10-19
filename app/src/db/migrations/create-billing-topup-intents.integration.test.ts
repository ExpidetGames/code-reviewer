// SPDX-License-Identifier: Apache-2.0

// #497: the migration of the top-up intents and the webhook event record, on SQLite and on Postgres. Both tables are new
// and empty; the event record has room for an id, an outcome and an order, and for no payload.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import {
  createTestDatabase,
  createTestDirectory,
} from "../../test-support/test-database.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";

const MIGRATION = "20261019170000_create_billing_topup_intents";
const T = "2026-10-19T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < MIGRATION,
      ),
    );
  },
};

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the top-up intent and webhook event tables on ${engine.name}`,
    () => {
      // #497-T12
      it("has no column that could hold a payload, an address or a name", async () => {
        const { db } = await engine.create();
        const { rows } = await sql<{ table_name: string; column_name: string }>`
          select table_name, column_name from information_schema.columns
          where table_name in ('billing_webhook_events', 'billing_topup_intents')`
          .execute(db)
          .catch(async () =>
            // SQLite has no information_schema: read the pragma of each table.
            ({
              rows: (
                await Promise.all(
                  ["billing_webhook_events", "billing_topup_intents"].map(
                    async (table) =>
                      (
                        await sql<{
                          name: string;
                        }>`select name from pragma_table_info(${table})`.execute(
                          db,
                        )
                      ).rows.map((column) => ({
                        table_name: table,
                        column_name: column.name,
                      })),
                  ),
                )
              ).flat(),
            }),
          );

        const events = rows
          .filter((row) => row.table_name === "billing_webhook_events")
          .map((row) => row.column_name)
          .sort();
        expect(events).toEqual(
          [
            "event_id",
            "occurred_at",
            "outcome",
            "provider",
            "received_at",
            "review_state",
            "subject",
          ].sort(),
        );
        const intents = rows
          .filter((row) => row.table_name === "billing_topup_intents")
          .map((row) => row.column_name)
          .sort();
        expect(intents).toEqual(
          [
            "amount_micro_usd",
            "adapter",
            "created_at",
            "credited_micro_usd",
            "disputed_micro_usd",
            "id",
            "provider_checkout_ref",
            "provider_payment_ref",
            "refunded_micro_usd",
            "state",
            "updated_at",
            "workspace_id",
          ].sort(),
        );
      });

      // #497-T12
      it("refuses an intent of an unknown state, of a workspace that is not there, and a non positive amount", async () => {
        const { db, workspaceId } = await engine.create();
        const intent = (overrides: Record<string, unknown>) =>
          db
            .insertInto("billing_topup_intents")
            .values({
              id: `intent-${Math.random()}`,
              workspace_id: workspaceId,
              adapter: "fake",
              amount_micro_usd: 25_000_000,
              state: "pending",
              provider_checkout_ref: null,
              provider_payment_ref: null,
              created_at: T,
              updated_at: T,
              ...overrides,
            })
            .execute();

        await intent({});
        await expect(intent({ state: "refunded" })).rejects.toThrow();
        await expect(intent({ workspace_id: "missing" })).rejects.toThrow();
        await expect(intent({ amount_micro_usd: 0 })).rejects.toThrow();
        await expect(intent({ amount_micro_usd: -1 })).rejects.toThrow();
      });

      // #497-T05
      it("lets one payment and one checkout belong to one intent of an adapter", async () => {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        const intent = (
          id: string,
          workspace: string,
          adapter: string,
          payment: string | null,
          checkout: string | null,
        ) =>
          db
            .insertInto("billing_topup_intents")
            .values({
              id,
              workspace_id: workspace,
              adapter,
              amount_micro_usd: 25_000_000,
              state: "pending",
              provider_checkout_ref: checkout,
              provider_payment_ref: payment,
              created_at: T,
              updated_at: T,
            })
            .execute();

        await intent("i1", workspaceId, "fake", "pi_1", "cs_1");
        // Another adapter may use the same opaque id; many intents may have no reference yet.
        await intent("i2", workspaceId, "other", "pi_1", "cs_1");
        await intent("i3", workspaceId, "fake", null, null);
        await intent("i4", otherWorkspaceId, "fake", null, null);
        await expect(
          intent("i5", otherWorkspaceId, "fake", "pi_1", null),
        ).rejects.toThrow(/unique/i);
        await expect(
          intent("i6", otherWorkspaceId, "fake", null, "cs_1"),
        ).rejects.toThrow(/unique/i);
      });

      // #497-T04
      it("keeps one row for each event id of a provider", async () => {
        const { db } = await engine.create();
        const event = (provider: string, eventId: string) =>
          db
            .insertInto("billing_webhook_events")
            .values({
              provider,
              event_id: eventId,
              outcome: "applied",
              subject: null,
              occurred_at: null,
              received_at: T,
            })
            .execute();

        await event("fake", "evt_1");
        await event("other", "evt_1");
        await expect(event("fake", "evt_1")).rejects.toThrow(/unique|primary/i);
      });
    },
  );
}

// #497-T12
describe("the migration", () => {
  const engines = [
    {
      name: "sqlite",
      skip: false,
      async before() {
        const directory = await createTestDirectory();
        return openDatabase({
          driver: "sqlite",
          path: `${directory}/app.db`,
          busyTimeoutMs: 5000,
        });
      },
    },
    {
      name: "postgres",
      skip: !hasPostgres(),
      async before() {
        return (await createPostgresTestDatabase({ migrate: false })).db;
      },
    },
  ] as const;

  for (const engine of engines)
    describe.skipIf(engine.skip)(engine.name, () => {
      it("adds two empty tables to a database of the last release and changes no row", async () => {
        const db = await engine.before();
        await migrateToLatest(db, beforeThisMigration);
        await addWorkspace(db, "before");
        const before = await db.selectFrom("workspaces").selectAll().execute();

        await migrateToLatest(db);

        expect(await db.selectFrom("workspaces").selectAll().execute()).toEqual(
          before,
        );
        expect(
          await db.selectFrom("billing_topup_intents").selectAll().execute(),
        ).toEqual([]);
        expect(
          await db.selectFrom("billing_webhook_events").selectAll().execute(),
        ).toEqual([]);
        const names = (
          await sql<{
            name: string;
          }>`select name from kysely_migration order by name`.execute(db)
        ).rows.map((migrated) => migrated.name);
        expect(names).toContain(MIGRATION);
      });
    });

  it("sorts after the balance journal it builds on", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();
    expect(names).toContain(MIGRATION);
    expect(names).toContain("20261019150000_create_billing_journal");
    expect(MIGRATION > "20261019150000_create_billing_journal").toBe(true);
  });
});

// Keeps the import used when no Postgres is configured.
void createTestDatabase;
