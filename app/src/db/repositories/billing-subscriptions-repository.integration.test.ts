// SPDX-License-Identifier: Apache-2.0

// The repositories of the subscription state (#441, src/billing/README.md, "The webhook") on a real SQLite file and, when
// TEST_DATABASE_URL is set, on a real Postgres: the event log and its dedupe (instance level), the subscriptions, the customers
// and the checkouts of ONE workspace, and the directory that finds the workspace of a checkout or a subscription before a
// scoped repository can be made. The scoping itself is proven in scoped-isolation.integration.test.ts.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { PlanTerms } from "../../admin/ui/plans-view.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import { createBillingCheckoutsRepository } from "./billing-checkouts-repository.ts";
import { createBillingCustomersRepository } from "./billing-customers-repository.ts";
import { createBillingDirectoryRepository } from "./billing-directory-repository.ts";
import { createBillingPlansRepository } from "./billing-plans-repository.ts";
import { createBillingPlanVersionsRepository } from "./billing-plan-versions-repository.ts";
import {
  createBillingSubscriptionsRepository,
  type SubscriptionPatch,
} from "./billing-subscriptions-repository.ts";
import { createBillingWebhookEventsRepository } from "./billing-webhook-events-repository.ts";

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () => (await createTestDatabase()).db,
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase()).db,
    skip: !hasPostgres(),
  },
];

const T1 = "2026-10-18T10:00:00.000Z";
const T2 = "2026-10-18T11:00:00.000Z";
const T3 = "2026-10-18T12:00:00.000Z";

const TERMS: PlanTerms = {
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 40,
    dynamicRunsPerPeriod: 8,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  modelAccess: { catalogEntries: null },
  monthlyAmountMinor: 1234,
  yearlyAmountMinor: 12_340,
};

function patch(overrides: Partial<SubscriptionPatch> = {}): SubscriptionPatch {
  return {
    planVersionId: "set below",
    paddlePriceId: "pri_1",
    billingInterval: "month",
    status: "active",
    pastDueSince: null,
    startedAt: T1,
    currentPeriodStart: T1,
    currentPeriodEnd: T3,
    nextBilledAt: T3,
    canceledAt: null,
    scheduledChangeAction: null,
    scheduledChangeAt: null,
    ...overrides,
  };
}

describe.each(ENGINES)("the subscription repositories on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function start() {
    const db = await engine.open();
    const workspaceA = await defaultWorkspaceId(db);
    const workspaceB = await addWorkspace(db, "other");
    const plans = createBillingPlansRepository(db);
    const plan = await plans.insert(
      {
        planKey: "team",
        kind: "paid",
        metadata: {
          name: "Team",
          description: "",
          sort: 1,
          offered: true,
          popular: false,
          contactTarget: null,
        },
      },
      null,
    );
    const version = await createBillingPlanVersionsRepository(db).createNext(
      plan.id,
      TERMS,
      null,
      0,
    );
    const subscriptionsOf = (workspaceId: string) =>
      createBillingSubscriptionsRepository(db, workspaceId);
    const input = (
      paddleId: string,
      overrides: Partial<SubscriptionPatch> = {},
    ) => ({
      env: "sandbox" as const,
      paddleSubscriptionId: paddleId,
      paddleCustomerId: "ctm_1",
      stamp: { occurredAt: T1, eventId: `evt_${paddleId}` },
      ...patch({ planVersionId: version.id, ...overrides }),
    });
    return { db, workspaceA, workspaceB, version, subscriptionsOf, input };
  }

  describe("the webhook events", () => {
    // #441-T04
    it_("claims an event id once, and says so to every later try", async () => {
      const { db } = await start();
      const events = createBillingWebhookEventsRepository(db);
      const event = {
        eventId: "evt_1",
        env: "sandbox" as const,
        eventType: "subscription.updated",
        occurredAt: T1,
        entityId: "sub_1",
      };

      expect(await events.claim(event)).toBe(true);
      expect(await events.claim(event)).toBe(false);
      expect(await events.get("evt_1")).toMatchObject({
        eventId: "evt_1",
        outcome: "pending",
        entityId: "sub_1",
        occurredAt: T1,
      });
    });

    // #441-T04
    it_("lets exactly one of several concurrent claims win", async () => {
      const { db } = await start();
      const events = createBillingWebhookEventsRepository(db);
      const event = {
        eventId: "evt_race",
        env: "sandbox" as const,
        eventType: "subscription.updated",
        occurredAt: T1,
        entityId: null,
      };

      const results = await Promise.all(
        Array.from({ length: 6 }, () => events.claim(event)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it_("records the outcome of an event", async () => {
      const { db } = await start();
      const events = createBillingWebhookEventsRepository(db);
      await events.claim({
        eventId: "evt_1",
        env: "sandbox",
        eventType: "price.updated",
        occurredAt: T1,
        entityId: null,
      });

      await events.setOutcome("evt_1", "stale_ignored");

      expect((await events.get("evt_1"))?.outcome).toBe("stale_ignored");
      expect(await events.get("evt_missing")).toBeUndefined();
    });
  });

  describe("the subscriptions of a workspace", () => {
    // #441-T03
    it_(
      "inserts a subscription and reads it back by its Paddle id",
      async () => {
        const { workspaceA, subscriptionsOf, input, version } = await start();
        const subscriptions = subscriptionsOf(workspaceA);

        const result = await subscriptions.insert(input("sub_1"));

        expect(result.ok).toBe(true);
        const found = await subscriptions.getByPaddleId("sandbox", "sub_1");
        expect(found).toMatchObject({
          workspaceId: workspaceA,
          paddleSubscriptionId: "sub_1",
          planVersionId: version.id,
          status: "active",
          billingInterval: "month",
          lastEventOccurredAt: T1,
          lastEventId: "evt_sub_1",
        });
        expect(await subscriptions.getLive()).toMatchObject({
          paddleSubscriptionId: "sub_1",
        });
      },
    );

    // #441-T11
    it_(
      "refuses a second live subscription for the workspace and says why, and frees it when the first is canceled",
      async () => {
        const { workspaceA, workspaceB, subscriptionsOf, input } =
          await start();
        const subscriptions = subscriptionsOf(workspaceA);
        await subscriptions.insert(input("sub_1"));

        const second = await subscriptions.insert(input("sub_2"));
        const otherWorkspace = await subscriptionsOf(workspaceB).insert(
          input("sub_3"),
        );

        expect(second).toEqual({
          ok: false,
          reason: "workspace_has_live_subscription",
        });
        expect(otherWorkspace.ok).toBe(true);
        expect(
          await subscriptions.getByPaddleId("sandbox", "sub_2"),
        ).toBeUndefined();
        const first = await subscriptions.getByPaddleId("sandbox", "sub_1");
        await subscriptions.applyEvent(
          first?.id ?? "",
          patch({
            status: "canceled",
            planVersionId: first?.planVersionId ?? "",
          }),
          { occurredAt: T2, eventId: "evt_cancel" },
        );
        expect((await subscriptions.insert(input("sub_2"))).ok).toBe(true);
      },
    );

    it_(
      "says the subscription exists when the same Paddle subscription is inserted twice",
      async () => {
        const { workspaceA, subscriptionsOf, input } = await start();
        const subscriptions = subscriptionsOf(workspaceA);
        await subscriptions.insert(input("sub_1"));

        expect(await subscriptions.insert(input("sub_1"))).toEqual({
          ok: false,
          reason: "subscription_exists",
        });
      },
    );

    // #441-T05
    it_(
      "applies an event that is not older than the last one, ties included, and refuses an older one",
      async () => {
        const { workspaceA, subscriptionsOf, input } = await start();
        const subscriptions = subscriptionsOf(workspaceA);
        await subscriptions.insert(input("sub_1"));
        const row = await subscriptions.getByPaddleId("sandbox", "sub_1");
        const id = row?.id ?? "";
        const base = { planVersionId: row?.planVersionId ?? "" };

        const newer = await subscriptions.applyEvent(
          id,
          patch({ ...base, status: "past_due", pastDueSince: T2 }),
          { occurredAt: T2, eventId: "evt_2" },
        );
        const older = await subscriptions.applyEvent(
          id,
          patch({ ...base, status: "active" }),
          { occurredAt: T1, eventId: "evt_older" },
        );
        const tie = await subscriptions.applyEvent(
          id,
          patch({ ...base, status: "paused" }),
          { occurredAt: T2, eventId: "evt_tie" },
        );

        expect([newer, older, tie]).toEqual([true, false, true]);
        expect(
          await subscriptions.getByPaddleId("sandbox", "sub_1"),
        ).toMatchObject({
          status: "paused",
          lastEventOccurredAt: T2,
          lastEventId: "evt_tie",
        });
      },
    );

    // #441-T05
    it_(
      "lets one of two concurrent events with the same stamp rule apply the newer state",
      async () => {
        const { workspaceA, subscriptionsOf, input } = await start();
        const subscriptions = subscriptionsOf(workspaceA);
        await subscriptions.insert(input("sub_1"));
        const row = await subscriptions.getByPaddleId("sandbox", "sub_1");
        const id = row?.id ?? "";
        const base = { planVersionId: row?.planVersionId ?? "" };

        const results = await Promise.all([
          subscriptions.applyEvent(id, patch({ ...base, status: "paused" }), {
            occurredAt: T2,
            eventId: "evt_new",
          }),
          subscriptions.applyEvent(id, patch({ ...base, status: "active" }), {
            occurredAt: T1,
            eventId: "evt_old",
          }),
        ]);

        expect(results[0]).toBe(true);
        expect(
          await subscriptions.getByPaddleId("sandbox", "sub_1"),
        ).toMatchObject({ status: "paused", lastEventId: "evt_new" });
      },
    );

    it_(
      "changes nothing for a subscription id of another workspace",
      async () => {
        const { workspaceA, workspaceB, subscriptionsOf, input } =
          await start();
        await subscriptionsOf(workspaceA).insert(input("sub_1"));
        const row = await subscriptionsOf(workspaceA).getByPaddleId(
          "sandbox",
          "sub_1",
        );

        const changed = await subscriptionsOf(workspaceB).applyEvent(
          row?.id ?? "",
          patch({
            status: "canceled",
            planVersionId: row?.planVersionId ?? "",
          }),
          { occurredAt: T3, eventId: "evt_x" },
        );

        expect(changed).toBe(false);
        expect(
          await subscriptionsOf(workspaceB).getByPaddleId("sandbox", "sub_1"),
        ).toBeUndefined();
        expect((await subscriptionsOf(workspaceA).getLive())?.status).toBe(
          "active",
        );
      },
    );
  });

  describe("the customers of a workspace", () => {
    // #441-T03
    it_(
      "adopts a customer id per environment and replaces it with a newer one",
      async () => {
        const { db, workspaceA, workspaceB } = await start();
        const customers = createBillingCustomersRepository(db, workspaceA);

        await customers.adopt("sandbox", "ctm_1");
        await customers.adopt("sandbox", "ctm_1");
        await customers.adopt("live", "ctm_live");
        await customers.adopt("sandbox", "ctm_2");

        expect(await customers.get("sandbox")).toBe("ctm_2");
        expect(await customers.get("live")).toBe("ctm_live");
        expect(
          await createBillingCustomersRepository(db, workspaceB).get("sandbox"),
        ).toBeUndefined();
      },
    );
  });

  describe("the checkouts of a workspace and the directory", () => {
    it_("reads a checkout by its Paddle transaction", async () => {
      const { db, workspaceA, workspaceB, version } = await start();
      const checkouts = createBillingCheckoutsRepository(db, workspaceA);

      const created = await checkouts.create({
        env: "sandbox",
        transactionId: "txn_1",
        planVersionId: version.id,
        billingInterval: "year",
      });

      expect(await checkouts.getByTransaction("sandbox", "txn_1")).toEqual(
        created,
      );
      expect(created).toMatchObject({
        workspaceId: workspaceA,
        planVersionId: version.id,
        billingInterval: "year",
      });
      expect(await checkouts.getByTransaction("live", "txn_1")).toBeUndefined();
      expect(
        await createBillingCheckoutsRepository(db, workspaceB).getByTransaction(
          "sandbox",
          "txn_1",
        ),
      ).toBeUndefined();
    });

    // #441-T03, #441-T07
    it_(
      "finds the workspace of a checkout and of a subscription, and nothing for ids it does not know",
      async () => {
        const { db, workspaceA, workspaceB, version, subscriptionsOf, input } =
          await start();
        await createBillingCheckoutsRepository(db, workspaceB).create({
          env: "sandbox",
          transactionId: "txn_b",
          planVersionId: version.id,
          billingInterval: "month",
        });
        await subscriptionsOf(workspaceA).insert(input("sub_a"));
        const directory = createBillingDirectoryRepository(db);

        expect(await directory.workspaceOfCheckout("sandbox", "txn_b")).toBe(
          workspaceB,
        );
        expect(
          await directory.workspaceOfSubscription("sandbox", "sub_a"),
        ).toBe(workspaceA);
        expect(
          await directory.workspaceOfCheckout("live", "txn_b"),
        ).toBeUndefined();
        expect(
          await directory.workspaceOfCheckout("sandbox", "txn_unknown"),
        ).toBeUndefined();
        expect(
          await directory.workspaceOfSubscription("sandbox", "sub_unknown"),
        ).toBeUndefined();
      },
    );

    it_("stores ids, states and times only", async () => {
      const { db, workspaceA, subscriptionsOf, input } = await start();
      await subscriptionsOf(workspaceA).insert(input("sub_1"));

      const columns = await sql<{ name: string }>`${
        engine.name === "SQLite"
          ? sql`select name from pragma_table_info('billing_subscriptions')`
          : sql`select column_name as name from information_schema.columns where table_name = 'billing_subscriptions'`
      }`.execute(db);

      expect(columns.rows.map((row) => row.name).sort()).toEqual(
        [
          "billing_interval",
          "canceled_at",
          "created_at",
          "current_period_end",
          "current_period_start",
          "id",
          "last_event_id",
          "last_event_occurred_at",
          "next_billed_at",
          "paddle_customer_id",
          "paddle_env",
          "paddle_price_id",
          "paddle_subscription_id",
          "past_due_since",
          "plan_version_id",
          "scheduled_change_action",
          "scheduled_change_at",
          "started_at",
          "status",
          "updated_at",
          "workspace_id",
        ].sort(),
      );
    });
  });
});
