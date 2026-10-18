// SPDX-License-Identifier: Apache-2.0

// #441: the migration that adds the subscription state of billing (`billing_customers`, `billing_subscriptions`,
// `billing_checkouts`) and the instance level log of the webhook events (`billing_webhook_events`). It adds four empty
// tables and touches no existing row. What the database keeps true on its own, whichever app instance writes, is
// checked on SQLite and on Postgres: one live subscription per workspace, one row per Paddle subscription, one
// checkout per Paddle transaction, one row per event id.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const THIS = "20261018180000_create_billing_subscriptions";
const T = "2026-10-18T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () =>
      openDatabase({
        driver: "sqlite",
        path: `${await createTestDirectory()}/app.db`,
        busyTimeoutMs: 5000,
      }),
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase({ migrate: false })).db,
    skip: !hasPostgres(),
  },
];

async function seedWorkspacesAndVersion(db: Kysely<Database>) {
  for (const id of ["w1", "w2"])
    await sql`insert into workspaces (id, name, slug, created_at, created_by) values (${id}, ${id}, ${id}, ${T}, null)`.execute(
      db,
    );
  await sql`insert into billing_plans (id, plan_key, name, description, sort, kind, offered, popular, created_at, updated_at)
    values ('p1', 'team', 'Team', '', 1, 'paid', 1, 0, ${T}, ${T})`.execute(db);
  await sql`insert into billing_plan_versions (id, plan_id, number, role, key_mode, limits, model_access, monthly_amount_minor, created_at)
    values ('v1', 'p1', 1, 'current', 'managed', '{}', '{"catalogEntries":null}', 1234, ${T})`.execute(
    db,
  );
}

type SubscriptionValues = {
  id: string;
  workspace: string;
  paddleId: string;
  env: string;
  status: string;
  interval: string;
};

function insertSubscription(
  db: Kysely<Database>,
  overrides: Partial<SubscriptionValues> = {},
) {
  const v: SubscriptionValues = {
    id: "s1",
    workspace: "w1",
    paddleId: "sub_1",
    env: "sandbox",
    status: "active",
    interval: "month",
    ...overrides,
  };
  return sql`insert into billing_subscriptions
    (id, workspace_id, paddle_env, paddle_subscription_id, paddle_customer_id, plan_version_id, paddle_price_id, billing_interval, status, last_event_occurred_at, last_event_id, created_at, updated_at)
    values (${v.id}, ${v.workspace}, ${v.env}, ${v.paddleId}, 'ctm_1', 'v1', 'pri_1', ${v.interval}, ${v.status}, ${T}, 'evt_1', ${T}, ${T})`.execute(
    db,
  );
}

describe("the billing subscriptions migration", () => {
  it("sorts after the migration that adds the price cache", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261018160000_create_billing_plan_prices"),
    );
  });

  describe.each(ENGINES)("on $name", (engine) => {
    const it_ = engine.skip ? it.skip : it;

    async function migrated() {
      const db = await engine.open();
      await migrateToLatest(db);
      await seedWorkspacesAndVersion(db);
      return db;
    }

    it_(
      "adds four empty tables and changes no row that was there",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, beforeThisMigration);
        await seedWorkspacesAndVersion(db);

        await migrateToLatest(db);

        for (const table of [
          "billing_customers",
          "billing_subscriptions",
          "billing_checkouts",
          "billing_webhook_events",
        ] as const)
          expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
        const plans = await db
          .selectFrom("billing_plans")
          .selectAll()
          .execute();
        expect(plans.map((plan) => plan.plan_key)).toEqual(["team"]);
        await db.destroy();
      },
    );

    // #441-T11
    it_(
      "refuses a second live subscription for one workspace, whatever app instance writes",
      async () => {
        const db = await migrated();
        await insertSubscription(db);

        await expect(
          insertSubscription(db, { id: "s2", paddleId: "sub_2" }),
        ).rejects.toThrow();
        // A paused subscription is live too: the workspace still holds it.
        await sql`update billing_subscriptions set status = 'paused' where id = 's1'`.execute(
          db,
        );
        await expect(
          insertSubscription(db, { id: "s2", paddleId: "sub_2" }),
        ).rejects.toThrow();
        await db.destroy();
      },
    );

    // #441-T11
    it_(
      "lets a workspace subscribe again once its subscription is canceled, and keeps workspaces apart",
      async () => {
        const db = await migrated();
        await insertSubscription(db);
        await insertSubscription(db, {
          id: "s9",
          workspace: "w2",
          paddleId: "sub_9",
        });
        await sql`update billing_subscriptions set status = 'canceled' where id = 's1'`.execute(
          db,
        );

        await insertSubscription(db, { id: "s2", paddleId: "sub_2" });

        const live = await sql<{
          workspace_id: string;
        }>`select workspace_id from billing_subscriptions where status <> 'canceled' order by workspace_id`.execute(
          db,
        );
        expect(live.rows.map((row) => row.workspace_id)).toEqual(["w1", "w2"]);
        await db.destroy();
      },
    );

    it_(
      "keeps one row for a Paddle subscription of an environment, and lets the other environment reuse the id",
      async () => {
        const db = await migrated();
        await insertSubscription(db);
        await sql`update billing_subscriptions set status = 'canceled' where id = 's1'`.execute(
          db,
        );

        await expect(
          insertSubscription(db, { id: "s2", paddleId: "sub_1" }),
        ).rejects.toThrow();
        await insertSubscription(db, {
          id: "s3",
          paddleId: "sub_1",
          env: "live",
        });
        await db.destroy();
      },
    );

    it_(
      "refuses a status, an interval and an environment the code does not know",
      async () => {
        const db = await migrated();

        await expect(
          insertSubscription(db, { status: "gone" }),
        ).rejects.toThrow();
        await expect(
          insertSubscription(db, { interval: "week" }),
        ).rejects.toThrow();
        await expect(
          insertSubscription(db, { env: "staging" }),
        ).rejects.toThrow();
        await db.destroy();
      },
    );

    // #441-T04
    it_(
      "keeps one row per event id and lets `on conflict do nothing` answer that nothing was inserted",
      async () => {
        const db = await migrated();
        const insert = () =>
          sql`insert into billing_webhook_events (event_id, paddle_env, event_type, occurred_at, outcome, received_at)
          values ('evt_1', 'sandbox', 'subscription.created', ${T}, 'applied', ${T}) on conflict do nothing`.execute(
            db,
          );

        const first = await insert();
        const second = await insert();

        expect(Number(first.numAffectedRows)).toBe(1);
        expect(Number(second.numAffectedRows)).toBe(0);
        await db.destroy();
      },
    );

    it_(
      "keeps one checkout per Paddle transaction of an environment and one customer per workspace and environment",
      async () => {
        const db = await migrated();
        const checkout = (id: string, env: string, transaction: string) =>
          sql`insert into billing_checkouts (id, workspace_id, paddle_env, transaction_id, plan_version_id, billing_interval, created_at)
          values (${id}, 'w1', ${env}, ${transaction}, 'v1', 'month', ${T})`.execute(
            db,
          );
        await checkout("c1", "sandbox", "txn_1");

        await expect(checkout("c2", "sandbox", "txn_1")).rejects.toThrow();
        await checkout("c3", "live", "txn_1");
        await sql`insert into billing_customers (workspace_id, paddle_env, paddle_customer_id, created_at, updated_at) values ('w1', 'sandbox', 'ctm_1', ${T}, ${T})`.execute(
          db,
        );
        await expect(
          sql`insert into billing_customers (workspace_id, paddle_env, paddle_customer_id, created_at, updated_at) values ('w1', 'sandbox', 'ctm_2', ${T}, ${T})`.execute(
            db,
          ),
        ).rejects.toThrow();
        await db.destroy();
      },
    );

    it_(
      "refuses a subscription that points at a version or a workspace that does not exist, and never deletes a version in use",
      async () => {
        const db = await migrated();

        await expect(
          insertSubscription(db, { workspace: "nobody" }),
        ).rejects.toThrow();
        await insertSubscription(db);
        await expect(
          sql`delete from billing_plan_versions where id = 'v1'`.execute(db),
        ).rejects.toThrow();
        await db.destroy();
      },
    );

    it_("drops the four tables again when migrated down", async () => {
      const db = await migrated();

      const all = await migrationProvider.getMigrations();
      await all[THIS]?.down(db);

      for (const table of [
        "billing_customers",
        "billing_subscriptions",
        "billing_checkouts",
        "billing_webhook_events",
      ])
        await expect(
          sql.raw(`select 1 from ${table}`).execute(db),
        ).rejects.toThrow();
      await db.destroy();
    });
  });
});
